/**
 * User-model companion over the proxy: the selectUserModel RPC arms and
 * disarms the durable companion, an armed companion answers questions and
 * decides approvals before the human sees them, and any companion failure
 * falls back to the human UI unchanged.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { readUserModelSelection } from '@deepseek-ai/dsh-user-model'
import type { ApiProxy, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`user-model-${String(nextRpc++)}`), payload }
}

function expectValue<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!response.result.ok) throw new Error(`expected successful response: ${JSON.stringify(response.result.error)}`)
  return response.result.value
}

/** One scripted-text adapter serving the user-model route. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: (string | Error)[]) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider: 'user-mock', id: 'user-model-1', name: 'User Model' }])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: entry } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Prompt text the companion saw on its last call (transcript plus framing). */
function requestText(options: GenerateOptions): string {
  return options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

interface Harness {
  readonly ctx: Context
  readonly api: ApiProxy
  readonly adapter: ScriptedAdapter
  readonly agent: Agent
  readonly sessionId: SessionId
}

async function harness(script: (string | Error)[]): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ApprovalService)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['user-mock'], adapter)
  const session = ctx.sessions.create()
  session.append('turn/start', { turn: 1 })
  const agent = {
    id: session.id, session, status: 'running', ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'user-mock', model: 'user-model-1' }),
    cwd: '/tmp',
  })
  return { ctx, api, adapter, agent, sessionId: session.id }
}

/** Open a mux stream and capture frames for presence/absence assertions. */
function framesOf(api: ApiProxy, abort: AbortController): MuxFrame[] {
  const frames: MuxFrame[] = []
  void (async () => {
    for await (const envelope of api.events.mux({ rpcId: RpcId('um-mux'), payload: {} }, abort.signal)) {
      frames.push(envelope.payload)
    }
  })()
  return frames
}

/** Arm the companion directly on the session, as selectUserModel would. */
function arm(agent: Agent): void {
  agent.session.append('user-model/armed', {
    provider: 'user-mock', model: 'user-model-1', prompt: 'You want the workspace tidy.',
  })
}

const QUESTION = {
  id: 'targets',
  question: 'Which files should change?',
  options: [{ label: 'api' }, { label: 'web' }],
}

describe('selectUserModel RPC', () => {
  it('arms, validates, and disarms the durable companion', async () => {
    const { ctx, api, agent, sessionId } = await harness([])
    expect(readUserModelSelection(agent.session.events)).toBeNull()

    const selected = expectValue(await api.sessions.selectUserModel(request({
      sessionId, provider: 'user-mock', model: 'user-model-1', prompt: 'You want the workspace tidy.',
    })))
    expect(selected.selected).toEqual({
      provider: 'user-mock', model: 'user-model-1', prompt: 'You want the workspace tidy.',
    })
    // The arm is durable: a fresh fold over the session events reads it back.
    expect(readUserModelSelection(agent.session.events)).toEqual({
      provider: 'user-mock', model: 'user-model-1', prompt: 'You want the workspace tidy.',
    })

    const rejected = await api.sessions.selectUserModel(request({
      sessionId, provider: 'missing', model: 'model', prompt: 'x',
    }))
    expect(rejected.result).toEqual({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'no adapter registered for provider "missing"',
        details: { provider: 'missing', model: 'model' },
      },
    })
    // A refused route never reaches the durable state.
    expect(readUserModelSelection(agent.session.events)?.model).toBe('user-model-1')

    const cleared = expectValue(await api.sessions.selectUserModel(request({ sessionId })))
    expect(cleared.selected).toBeNull()
    expect(readUserModelSelection(agent.session.events)).toBeNull()
    expect(agent.session.events.some(event => event.type === 'user-model/disarmed'
      && (event.data as { reason: string }).reason === 'user')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rejects an unknown session', async () => {
    const { ctx, api } = await harness([])
    const response = await api.sessions.selectUserModel(request({
      sessionId: 'ghost' as SessionId, provider: 'user-mock', model: 'user-model-1', prompt: 'x',
    }))
    expect(response.result.ok).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('user-model question forwarding', () => {
  it('answers the agent\'s question without reaching the human', async () => {
    const { ctx, api, adapter, agent } = await harness([
      '{"answers":[{"id":"targets","selected":["api"]}]}',
    ])
    const abort = new AbortController()
    const frames = framesOf(api, abort)
    arm(agent)

    const answer = await ctx.userQuestions.ask({ agent, questions: [QUESTION] })
    expect(answer).toEqual({ answers: [{ id: 'targets', selected: ['api'] }] })
    // No human was consulted and the exact request is on the durable record.
    expect(frames.some(frame => frame.type === 'question/requested')).toBe(false)
    expect(agent.session.events.some(event => event.type === 'user-model/request'
      && (event.data as { purpose: string }).purpose === 'question')).toBe(true)
    expect(requestText(adapter.requests[0]!)).toContain(QUESTION.question)
    abort.abort()
    await ctx.fiber.dispose()
  })

  it('falls back to the human when the companion reply does not parse', async () => {
    const { ctx, api, agent } = await harness(['not json at all'])
    const abort = new AbortController()
    const frames: MuxFrame[] = []
    const envelopes: RpcRequest<MuxFrame>[] = []
    const requested = new Promise<RpcRequest<MuxFrame>>((resolve) => {
      void (async () => {
        for await (const envelope of api.events.mux({ rpcId: RpcId('um-mux'), payload: {} }, abort.signal)) {
          frames.push(envelope.payload)
          envelopes.push(envelope)
          if (envelope.payload.type === 'question/requested') resolve(envelope)
        }
      })()
    })
    arm(agent)

    const asked = ctx.userQuestions.ask({ agent, questions: [QUESTION] })
    const envelope = await requested
    const frame = envelope.payload as Extract<MuxFrame, { type: 'question/requested' }>
    const receipt = await api.respond({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: frame.sessionId,
          answer: { answers: [{ id: 'targets', selected: ['web'] }] },
        },
      },
    })
    expect(receipt).toEqual({ accepted: true })
    await expect(asked).resolves.toEqual({ answers: [{ id: 'targets', selected: ['web'] }] })
    abort.abort()
    await ctx.fiber.dispose()
  })
})

describe('user-model approval forwarding', () => {
  it('approves with the exact call arguments in view', async () => {
    const { ctx, api, adapter, agent } = await harness(['{"approved":true}'])
    const abort = new AbortController()
    const frames = framesOf(api, abort)
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Cleaning up.' },
          { type: 'tool-call', id: CallId('call-1'), name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' },
        ],
        source: { kind: 'model', provider: 'user-mock', model: 'user-model-1' },
      }),
    }, { surfaceOp: 'append' })
    arm(agent)

    await expect(ctx.approval.request({
      agent, toolName: 'bash', callId: CallId('call-1'), reason: 'sandbox escalation',
    })).resolves.toBe('allowed-once')
    expect(frames.some(frame => frame.type === 'approval/requested')).toBe(false)
    const prompt = requestText(adapter.requests[0]!)
    expect(prompt).toContain('rm -rf /tmp/x')
    expect(prompt).toContain('sandbox escalation')
    abort.abort()
    await ctx.fiber.dispose()
  })

  it('rejects a reason-less, callId-less ask', async () => {
    const { ctx, agent } = await harness(['{"approved":false}'])
    arm(agent)
    await expect(ctx.approval.request({ agent, toolName: 'write' })).resolves.toBe('rejected')
    await ctx.fiber.dispose()
  })

  it('frames unparseable call arguments verbatim', async () => {
    const { ctx, adapter, agent } = await harness(['{"approved":true}'])
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('call-2'), name: 'bash', arguments: '{broken' }],
        source: { kind: 'model', provider: 'user-mock', model: 'user-model-1' },
      }),
    }, { surfaceOp: 'append' })
    arm(agent)

    await expect(ctx.approval.request({ agent, toolName: 'bash', callId: CallId('call-2') }))
      .resolves.toBe('allowed-once')
    expect(requestText(adapter.requests[0]!)).toContain('{broken')
    await ctx.fiber.dispose()
  })

  it('falls back to the human when the companion verdict does not parse', async () => {
    const { ctx, api, agent } = await harness(['not json at all'])
    const abort = new AbortController()
    const requested = new Promise<RpcRequest<MuxFrame>>((resolve) => {
      void (async () => {
        for await (const envelope of api.events.mux({ rpcId: RpcId('um-mux'), payload: {} }, abort.signal)) {
          if (envelope.payload.type === 'approval/requested') resolve(envelope)
        }
      })()
    })
    arm(agent)

    const asked = ctx.approval.request({ agent, toolName: 'bash', reason: 'sandbox escalation' })
    const envelope = await requested
    const frame = envelope.payload as Extract<MuxFrame, { type: 'approval/requested' }>
    const receipt = await api.respond({
      type: 'client-response',
      rpcId: envelope.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          outcome: 'allowed-once',
        },
      },
    })
    expect(receipt).toEqual({ accepted: true })
    await expect(asked).resolves.toBe('allowed-once')
    abort.abort()
    await ctx.fiber.dispose()
  })
})
