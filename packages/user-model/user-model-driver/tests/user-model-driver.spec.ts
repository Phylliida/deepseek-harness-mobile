import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  JobId,
  JobRegistry,
} from '@deepseek-ai/dsh-jobs'
import type {
  JobRead,
  JobSnapshot,
  JobStart,
  JobsChangedListener,
} from '@deepseek-ai/dsh-jobs'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as userModelDriver from '../src/index.ts'

type ScriptEntry = StreamChunk[] | Error | 'hang' | ((options: GenerateOptions) => StreamChunk[])

/** Small request-recording adapter with a shift-register script. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) yield chunk
  }
}

/** One successful text response. */
function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One truncated response. */
function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Test-local job registry with a caller-controlled snapshot list. */
class StubJobRegistry extends JobRegistry {
  private snapshots: JobSnapshot[] = []
  private readonly changedListeners = new Set<JobsChangedListener>()

  /** Replace the served snapshots and announce the change. */
  setJobs(owner: Agent | undefined, snapshots: JobSnapshot[]): void {
    this.snapshots = snapshots
    for (const listener of this.changedListeners) listener(owner)
  }

  override start(_spec: JobStart): JobId {
    throw new Error('StubJobRegistry: start is not implemented')
  }

  override list(caller?: Agent): JobSnapshot[] {
    if (caller === undefined) return this.snapshots
    return this.snapshots.filter(snapshot => snapshot.ownerSession === caller.session.id)
  }

  override get(_id: JobId, _caller?: Agent): JobSnapshot {
    throw new Error('StubJobRegistry: get is not implemented')
  }

  override read(_id: JobId, _caller?: Agent): JobRead {
    throw new Error('StubJobRegistry: read is not implemented')
  }

  override kill(_id: JobId, _caller?: Agent): 'requested' | 'already-finished' {
    throw new Error('StubJobRegistry: kill is not implemented')
  }

  override wait(_id: JobId, _timeoutMs: number, _caller?: Agent): Promise<JobSnapshot> {
    throw new Error('StubJobRegistry: wait is not implemented')
  }

  override onJobDone(): () => void {
    return () => {}
  }

  override onJobsChanged(listener: JobsChangedListener): () => void {
    this.changedListeners.add(listener)
    return () => { this.changedListeners.delete(listener) }
  }

  override attachController(): () => void {
    return () => {}
  }
}

/** One synthetic snapshot for the quiescence gate. */
function jobSnapshot(agent: Agent, status: JobSnapshot['status']): JobSnapshot {
  return {
    id: JobId('stub-1'),
    kind: 'stub' as JobSnapshot['kind'],
    label: 'stub job',
    ownerSession: agent.session.id,
    status,
    startedAt: 1,
    reported: false,
  }
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly driver: { dispose(): Promise<void> }
  readonly jobs: StubJobRegistry
  readonly agent: Agent
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
})

/** Mount a real loop with only its model and jobs scripted. */
async function harness(
  script: ScriptEntry[],
  config: userModelDriver.Config = {},
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(StubJobRegistry)
  const jobs = ctx.jobs as unknown as StubJobRegistry
  const driver = await ctx.plugin(userModelDriver, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(`user-model-session-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, driver, jobs, agent }
}

/** Arm the user-model route on the durable log. */
function arm(agent: Agent, prompt = 'keep the agent working'): void {
  agent.session.append('user-model/armed', { provider: 'mock', model: 'mock', prompt })
}

/** Await a specific number of dispatched model requests. */
async function waitForRequests(adapter: ScriptedAdapter, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(adapter.requests.length).toBeGreaterThanOrEqual(count)
  })
}

/** Read the latest durable disarm reason. */
function disarmReason(agent: Agent): string | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]!
    if (event.type === 'user-model/disarmed') return event.data.reason
    if (event.type === 'user-model/armed') return undefined
  }
  return undefined
}

/** Await a durable disarm with an optional reason filter. */
async function waitForDisarm(agent: Agent, reason: string): Promise<void> {
  await vi.waitFor(() => {
    expect(disarmReason(agent)).toBe(reason)
  })
}

/** Texts of every durably queued user-model reply. */
function userModelReplies(agent: Agent): string[] {
  return agent.session.events
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'user-model')
    .map(event => event.type === 'user/message'
      ? event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : '')
}

/** The user-model generation call, identified by its persona system prompt. */
function isUserModelRequest(request: GenerateOptions): boolean {
  return String(request.system).includes('You are the user in this conversation.')
}

describe('user-model-driver', () => {
  it('generates a reply at quiescence and queues it as a user-model turn', async () => {
    const test = await harness([
      (options) => {
        expect(isUserModelRequest(options)).toBe(true)
        return textResponse('please continue with the next step')
      },
      textResponse('agent did more work'),
      (options) => {
        expect(isUserModelRequest(options)).toBe(true)
        return textResponse('<task-complete/>')
      },
    ])
    arm(test.agent)

    await waitForDisarm(test.agent, 'complete')

    expect(test.adapter.requests).toHaveLength(3)
    const replies = test.agent.session.events.filter(event =>
      event.type === 'user/message' && event.data.source.kind === 'user-model')
    expect(replies).toHaveLength(1)
    const reply = replies[0]!
    if (reply.type !== 'user/message') throw new Error('expected a user message')
    expect(reply.data.source).toEqual({ kind: 'user-model', provider: 'mock', model: 'mock' })
    expect(reply.data.content).toEqual([{ type: 'text', text: 'please continue with the next step' }])
    // The persona call carried the durable goal text in its system prompt.
    expect(String(test.adapter.requests[0]!.system)).toContain('keep the agent working')
  })

  it('does nothing while the user-model is not armed', async () => {
    const test = await harness([])
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('disarms durably when the reply budget is exhausted', async () => {
    const test = await harness([
      textResponse('first reply'),
      textResponse('agent did work'),
    ], { maxReplies: 1 })
    arm(test.agent)

    await waitForDisarm(test.agent, 'replies-exhausted')

    expect(test.adapter.requests).toHaveLength(2)
    expect(test.adapter.requests.some(isUserModelRequest)).toBe(true)
  })

  it('disarms when generation fails', async () => {
    const test = await harness([new Error('provider broke')])
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('disarms when a turn ends aborted or errored', async () => {
    const test = await harness([
      textResponse('go on'),
      new Error('agent model broke'),
    ])
    arm(test.agent)

    await waitForDisarm(test.agent, 'turn-failed')
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('waits for running background jobs and fires when they settle', async () => {
    const test = await harness([
      textResponse('jobs are done now'),
      textResponse('agent reply'),
      textResponse('<task-complete/>'),
    ])
    test.jobs.setJobs(test.agent, [jobSnapshot(test.agent, 'running')])
    arm(test.agent)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)

    test.jobs.setJobs(test.agent, [jobSnapshot(test.agent, 'completed')])

    await waitForRequests(test.adapter, 1)
    expect(isUserModelRequest(test.adapter.requests[0]!)).toBe(true)
    await waitForDisarm(test.agent, 'complete')
  })

  it('waits while the agent is busy or the inbox is occupied', async () => {
    const test = await harness([
      textResponse('human turn answer'),
      textResponse('stall reply'),
      textResponse('agent reply'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent, 'busy gate')
    // A human prompt occupies the agent; the driver must not interleave.
    test.agent.send(createUserMessage({
      content: [{ type: 'text', text: 'human first' }],
      source: { kind: 'user' },
    }), 'next-turn', true)

    await waitForRequests(test.adapter, 1)
    expect(isUserModelRequest(test.adapter.requests[0]!)).toBe(false)
    // Once the human turn completes and the agent goes idle, the driver fires.
    await waitForDisarm(test.agent, 'complete')
    const userModelCalls = test.adapter.requests.filter(isUserModelRequest)
    expect(userModelCalls).toHaveLength(2)
  })

  it('rejects a non-positive reply budget', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(StubJobRegistry)
    const failures: string[] = []
    for (const config of [{ maxReplies: 0 }, { maxTokens: -1 }]) {
      try {
        await ctx.plugin(userModelDriver, config)
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatch(/maxReplies/)
    expect(failures[1]).toMatch(/maxTokens/)
  })

  it('abandons an in-flight generation when competing input arrives', async () => {
    const test = await harness([
      'hang',
      textResponse('human turn answer'),
      textResponse('second reply'),
      textResponse('agent did work'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent)
    await waitForRequests(test.adapter, 1)

    test.agent.send(createUserMessage({
      content: [{ type: 'text', text: 'human interrupt' }],
      source: { kind: 'user' },
    }), 'next-turn', true)

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['second reply'])
  })

  it('drops a stale generation when the inbox fills mid-stream', async () => {
    const test = await harness([
      () => {
        test.agent.send(createUserMessage({
          content: [{ type: 'text', text: 'human mid-stream' }],
          source: { kind: 'user' },
        }), 'next-turn', true)
        return textResponse('stale reply')
      },
      textResponse('human turn answer'),
      textResponse('fresh reply'),
      textResponse('agent did work'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent)

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['fresh reply'])
  })

  it('drops a reply when the arming changes mid-generation', async () => {
    const test = await harness([
      () => {
        arm(test.agent, 'changed goal')
        return textResponse('stale reply')
      },
      textResponse('after rearm'),
      textResponse('agent did work'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent, 'original goal')

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['after rearm'])
  })

  it('disarms when the reply cannot be parsed', async () => {
    const test = await harness([textResponse('do this <task-complete/> and also that')])
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(userModelReplies(test.agent)).toEqual([])
  })

  it('disarms when the durability checkpoint fails', async () => {
    const test = await harness([
      textResponse('a reply'),
      textResponse('agent did work'),
    ])
    vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(() => Promise.reject(new Error('disk gone')))
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
  })

  it('re-checks readiness after the checkpoint settles', async () => {
    const test = await harness([
      textResponse('first reply'),
      textResponse('agent did work'),
      textResponse('human turn answer'),
      textResponse('second reply'),
      textResponse('agent did more work'),
      textResponse('<task-complete/>'),
    ])
    vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      test.agent.send(createUserMessage({
        content: [{ type: 'text', text: 'human during checkpoint' }],
        source: { kind: 'user' },
      }), 'next-turn', true)
      return true
    })
    arm(test.agent)

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['first reply', 'second reply'])
  })

  it('disarms when the reply cannot be queued', async () => {
    const test = await harness([textResponse('a reply')])
    vi.spyOn(test.agent, 'followup').mockImplementationOnce(() => {
      throw new Error('queue full')
    })
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(userModelReplies(test.agent)).toEqual([])
  })

  it('contains a driver failure inside the run loop and fails closed', async () => {
    const test = await harness([])
    vi.spyOn(test.jobs, 'list').mockImplementationOnce(() => {
      throw new Error('jobs broke')
    })
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains synchronous scheduler startup failure', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(() => {
      throw new Error('scheduler closed')
    })
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains an asynchronously rejected scheduler task', async () => {
    const test = await harness([])
    vi.spyOn(test.ctx.agents, 'withoutInitiator').mockImplementationOnce(
      () => Promise.reject(new Error('scheduler task rejected')),
    )
    arm(test.agent)

    await waitForDisarm(test.agent, 'generation-failed')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('ignores a turn failure reported for a retired agent', async () => {
    const test = await harness([textResponse('ordinary work')])
    const handle = await test.ctx.agents.create({
      sessionId: SessionId('user-model-session-retired'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'one ordinary turn' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    await handle.dispose()

    expect(test.ctx.agents.get(handle.agent.id)).toBeUndefined()
    agentEvents(test.ctx, handle.agent).emit('agent/error', {
      turn: 1,
      step: 1,
      error: new Error('late failure'),
    })

    expect(disarmReason(handle.agent)).toBeUndefined()
  })

  it('ignores session events without an owning agent', async () => {
    const test = await harness([])
    const orphan = test.ctx.sessions.create(SessionId('user-model-session-orphan'))
    orphan.append('user-model/armed', { provider: 'mock', model: 'mock', prompt: 'orphan goal' })
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('ignores a jobs change without an owner', async () => {
    const test = await harness([])
    test.jobs.setJobs(undefined, [])

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('records a human disarm without generating further replies', async () => {
    const test = await harness([textResponse('a reply')])
    arm(test.agent)
    await waitForRequests(test.adapter, 1)
    test.adapter.requests.length = 0

    test.agent.session.append('user-model/disarmed', { reason: 'user' })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)
    expect(disarmReason(test.agent)).toBe('user')
  })

  it('keeps driving after a turn ends truncated', async () => {
    const test = await harness([
      textResponse('a reply'),
      maxTokensResponse('truncated agent turn'),
      textResponse('second reply'),
      textResponse('agent did work'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent)

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['a reply', 'second reply'])
  })

  it('disarms when the reply turn ends aborted', async () => {
    const test = await harness([
      textResponse('a reply'),
      'hang',
    ])
    arm(test.agent)
    await waitForRequests(test.adapter, 2)

    test.agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })

    await waitForDisarm(test.agent, 'turn-failed')
  })

  it('skips a stale deferred disarm when the log already moved on', async () => {
    const test = await harness([])
    arm(test.agent)
    agentEvents(test.ctx, test.agent).emit('agent/error', {
      turn: 1,
      step: 1,
      error: new Error('late failure'),
    })
    test.agent.session.append('user-model/disarmed', { reason: 'user' })

    await new Promise(resolve => setTimeout(resolve, 20))
    const disarms = test.agent.session.events.filter(event => event.type === 'user-model/disarmed')
    expect(disarms).toHaveLength(1)
    expect(disarmReason(test.agent)).toBe('user')
  })

  it('contains a disarm that cannot commit', async () => {
    const test = await harness([])
    arm(test.agent)
    vi.spyOn(test.agent.session, 'append').mockImplementationOnce(() => {
      throw new Error('log full')
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    agentEvents(test.ctx, test.agent).emit('agent/error', {
      turn: 1,
      step: 1,
      error: new Error('late failure'),
    })

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not disarm'))
    })
  })

  it('stops accepting triggers once torn down', async () => {
    const test = await harness(['hang'])
    arm(test.agent)
    await waitForRequests(test.adapter, 1)

    const unloading = Promise.resolve(test.driver.dispose())
    agentEvents(test.ctx, test.agent).emit('agent/error', {
      turn: 1,
      step: 1,
      error: new Error('late failure'),
    })
    await unloading

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disarmReason(test.agent)).toBeUndefined()
  })

  it('drops a reply when background jobs appear mid-generation', async () => {
    const test = await harness([
      () => {
        test.jobs.setJobs(test.agent, [jobSnapshot(test.agent, 'running')])
        return textResponse('stale reply')
      },
      textResponse('fresh reply'),
      textResponse('agent did work'),
      textResponse('<task-complete/>'),
    ])
    arm(test.agent)
    await waitForRequests(test.adapter, 1)

    test.jobs.setJobs(test.agent, [jobSnapshot(test.agent, 'completed')])

    await waitForDisarm(test.agent, 'complete')
    expect(userModelReplies(test.agent)).toEqual(['fresh reply'])
  })

  it('fails closed without rescheduling when durability fails during teardown', async () => {
    const test = await harness([
      textResponse('a reply'),
      textResponse('agent did work'),
    ])
    let rejectFlush!: (error: unknown) => void
    const flushGate = new Promise<void>((_resolve, reject) => { rejectFlush = reject })
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => { await flushGate; return false })
    arm(test.agent)
    await waitForRequests(test.adapter, 2)
    await vi.waitFor(() => {
      expect(flush).toHaveBeenCalled()
    })

    const unloading = Promise.resolve(test.driver.dispose())
    rejectFlush(new Error('disk gone'))
    await unloading

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disarmReason(test.agent)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(2)
  })

  it('retires quietly when disposed before the first reply', async () => {
    const test = await harness([])
    arm(test.agent)
    await test.driver.dispose()

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.adapter.requests).toHaveLength(0)
  })
})
