import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { MembraneBridge } from '../src/membrane.ts'
import {
  AGENT_PARTICIPANT,
  messageSeq,
  openSessionRuntime,
  syncSessionMirror,
  syncToolDefinitions,
} from '../src/mirror.ts'
import type { SessionRuntime } from '../src/mirror.ts'

/** The bridge is a passive collaborator here: no compression call is made. */
const UNUSED_LLM = {} as LlmRuntime

const IMAGE: ContentBlock = {
  type: 'image',
  attachment: {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  },
} as unknown as ContentBlock

describe('session mirror', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function storeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'autobio-mirror-'))
    roots.push(root)
    return root
  }

  function open(root: string, sessionId = 'mirror'): Promise<SessionRuntime> {
    return openSessionRuntime(
      join(root, sessionId),
      resolveConfig({}),
      new MembraneBridge({
        llm: UNUSED_LLM,
        provider: 'test',
        model: 'test-model',
        maxTokens: 1024,
        agentParticipant: AGENT_PARTICIPANT,
      }),
      'test-model',
    )
  }

  it('mirrors append-origin history into the membrane vocabulary', async () => {
    const runtime = await open(storeRoot())
    const session = Session.create(SessionId('mirror-map'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'question' }, IMAGE],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'reasoning', text: 'thought' },
          { type: 'tool-call', id: CallId('call-1'), name: 'echo', arguments: '{"a":1}' },
          { type: 'tool-call', id: CallId('call-2'), name: 'echo', arguments: '{"a":' },
        ],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'tool said' }, IMAGE],
        isError: true,
      }),
    }, { surfaceOp: 'append' })
    // A result that reports no outcome at all keeps the flag absent.
    session.append('user/message', createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-2'),
        content: [{ type: 'text', text: 'bare result' }],
      }],
      source: { kind: 'tool', callId: CallId('call-2') },
    }), { surfaceOp: 'append' })

    // A fresh runtime starts before seq 0, so the whole log is consumed:
    // turn/start advances the watermark without mirroring.
    expect(syncSessionMirror(runtime, session)).toBe(5)
    expect(runtime.watermark).toBe(session.events.at(-1)!.seq)
    // Nothing new past the watermark: a second pass consumes nothing.
    expect(syncSessionMirror(runtime, session)).toBe(0)

    const messages = runtime.manager.getMessageWindow(0, 10).messages
    expect(messages.map(message => message.participant))
      .toEqual(['user', AGENT_PARTICIPANT, 'user', 'user'])
    expect(messages.map(message => message.metadata?.['dshSeq']))
      .toEqual(session.events.filter(event => event.type !== 'turn/start').map(event => event.seq))

    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'question' },
      { type: 'text', text: '[image omitted from memory mirror]' },
    ])
    expect(messages[1]!.content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'thought' },
      { type: 'tool_use', id: 'call-1', name: 'echo', input: { a: 1 } },
      // Unparseable arguments keep an empty input: the raw string is not
      // load-bearing for chunking or memory formation.
      { type: 'tool_use', id: 'call-2', name: 'echo', input: {} },
    ])
    // A tool result keeps only its text; the nested attachment degrades to a
    // placeholder, and the outcome flag rides through.
    expect(messages[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call-1',
      isError: true,
    })
    expect(String((messages[2]!.content[0] as { content: unknown }).content))
      .toContain('tool said')
    expect(messages[3]!.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'call-2',
      content: 'bare result',
    })
  })

  it('advances past non-surface, empty, and fold-replacement events without mirroring them', async () => {
    const runtime = await open(storeRoot())
    const session = Session.create(SessionId('mirror-skip'))
    session.append('turn/start', { turn: 1 })
    const question = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the first question' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const folded = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: '[Recall L1-0]\n\nI remember asking.' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: { op: 'replace', start: question.seq, end: question.seq }, sourceEventSeqs: [question.seq] })
    // A message with no surviving blocks mirrors nothing, but still advances.
    const empty = session.append('user/message', createUserMessage({
      content: [],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/start', { turn: 2 })

    expect(syncSessionMirror(runtime, session)).toBe(5)
    expect(runtime.watermark).toBe(session.events.at(-1)!.seq)
    // The fold node is this backend's own output and never re-enters as history.
    expect(runtime.manager.getMessageCount()).toBe(1)
    expect(messageSeq(runtime, runtime.manager.getMessageWindow(0, 1).messages[0]!.id)).toBe(question.seq)
    expect(folded.seq).toBeGreaterThan(question.seq)
    expect(empty.seq).toBeGreaterThan(folded.seq)
  })

  it('recovers the replay watermark from the newest stamped message', async () => {
    const root = storeRoot()
    const first = await open(root)
    const session = Session.create(SessionId('mirror-resume'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before the restart' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    syncSessionMirror(first, session)
    first.manager.close()

    // A harness restart reopens the same archive: the newest stamped seq is the
    // watermark, so the old history is not mirrored a second time.
    const second = await open(root)
    expect(second.watermark).toBe(session.events.at(-1)!.seq)
    expect(syncSessionMirror(second, session)).toBe(0)
    second.manager.close()
  })

  it('leaves unstamped and malformed stamps unclaimed', async () => {
    const root = storeRoot()
    const first = await open(root)
    const unstamped = first.manager.addMessage('user', [{ type: 'text', text: 'strategy-authored marker' }])
    expect(messageSeq(first, unstamped)).toBeUndefined()
    first.manager.close()

    const second = await open(root)
    // A non-integer stamp is not a sequence number, so the mirror replays from
    // the start rather than trusting it.
    expect(second.watermark).toBe(-1)
    expect(messageSeq(second, unstamped)).toBeUndefined()
    second.manager.close()
  })

  it('pushes the session tool schemas into the archive', async () => {
    const runtime = await open(storeRoot())
    const session = Session.create(SessionId('mirror-tools'))
    session.append('request/header', {
      header: {
        config: { provider: 'test', model: 'test-model' },
        tools: [
          {
            name: 'echo',
            description: 'Echo the input',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          // A schema declaring neither key keeps the membrane shape minimal.
          { name: 'bare', description: 'No declared parameters', parameters: {} },
        ],
      },
      reason: 'initial',
    })
    const spy = vi.spyOn(runtime.manager, 'setToolDefinitions')

    syncToolDefinitions(runtime, session)

    expect(spy).toHaveBeenCalledWith([
      {
        name: 'echo',
        description: 'Echo the input',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      { name: 'bare', description: 'No declared parameters', inputSchema: { type: 'object' } },
    ])
    // The library stores the definitions in its own slot; the strategy reads
    // them there to decide whether a tool-bearing chunk may be compressed yet.
    expect((runtime.manager as unknown as { toolDefinitions?: unknown }).toolDefinitions)
      .toEqual([
        {
          name: 'echo',
          description: 'Echo the input',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
        { name: 'bare', description: 'No declared parameters', inputSchema: { type: 'object' } },
      ])
  })

  it('pushes nothing before the session has a request header or tools', async () => {
    const runtime = await open(storeRoot())
    const session = Session.create(SessionId('mirror-untooled'))
    const spy = vi.spyOn(runtime.manager, 'setToolDefinitions')

    // No header at all, then a header carrying a config but no tools.
    syncToolDefinitions(runtime, session)
    session.append('request/header', {
      header: { config: { provider: 'test', model: 'test-model' } },
      reason: 'initial',
    })
    syncToolDefinitions(runtime, session)

    expect(spy).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-numeric stamp', { dshSeq: 'seven' }],
    ['an unsafe-integer stamp', { dshSeq: Number.MAX_SAFE_INTEGER + 2 }],
  ])('ignores %s when recovering the watermark', async (_label, metadata) => {
    const root = storeRoot()
    const first = await open(root)
    const id = first.manager.addMessage('user', [{ type: 'text', text: 'hand written' }], metadata)
    expect(messageSeq(first, id)).toBeUndefined()
    first.manager.close()

    const second = await open(root)
    expect(second.watermark).toBe(-1)
    second.manager.close()
  })

  it('passes configured tunables to the strategy and leaves unset ones to the library', async () => {
    const root = storeRoot()
    const tuned = await openSessionRuntime(
      join(root, 'tuned'),
      resolveConfig({
        recentWindowTokens: 5,
        headWindowTokens: 6,
        maxMessageTokens: 9,
        targetChunkTokens: 7,
        mergeThreshold: 3,
        maxTokens: 8,
        foldingStrategy: 'flat-profile',
      }),
      new MembraneBridge({
        llm: UNUSED_LLM,
        provider: 'test',
        model: 'test-model',
        agentParticipant: AGENT_PARTICIPANT,
      }),
      'test-model',
    )
    // `config` is protected on the strategy; the test reads it structurally.
    const tunedConfig = (tuned.strategy as unknown as { config: Record<string, unknown> }).config
    expect(tunedConfig).toMatchObject({
      recentWindowTokens: 5,
      headWindowTokens: 6,
      maxMessageTokens: 9,
      targetChunkTokens: 7,
      mergeThreshold: 3,
      compressionMaxTokens: 8,
      foldingStrategy: 'flat-profile',
    })
    tuned.manager.close()

    const plain = await open(root, 'plain')
    const plainConfig = (plain.strategy as unknown as { config: Record<string, unknown> }).config
    expect(plainConfig).toMatchObject({
      recentWindowTokens: 30_000,
      headWindowTokens: 4000,
      maxMessageTokens: 10_000,
    })
    expect(plainConfig['targetChunkTokens']).toBe(3000)
    expect(plainConfig['mergeThreshold']).toBe(6)
    expect(plainConfig['compressionMaxTokens']).toBeUndefined()
    expect(plainConfig['foldingStrategy']).toBe('kv-stable')
    plain.manager.close()
  })
})
