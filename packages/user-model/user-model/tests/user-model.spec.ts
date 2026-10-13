import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  apply,
  buildUserModelTranscript,
  callUserModel,
  countUserModelReplies,
  parseUserModelApproval,
  parseUserModelQuestions,
  parseUserModelReply,
  readUserModelSelection,
  renderUserModelApprovalPrompt,
  renderUserModelQuestionsPrompt,
  renderUserModelSystemPrompt,
  USER_MODEL_COMPLETE_MARKER,
  UserModelParseError,
  userModelProjection,
} from '../src/index.ts'
import type { UserModelSelection } from '../src/index.ts'

const selection: UserModelSelection = { provider: 'anthropic', model: 'claude-opus', prompt: 'Ship the feature' }

/** One user-model-sourced user message event. */
function appendUserModelReply(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user-model', provider: selection.provider, model: selection.model },
  }), { surfaceOp: 'append' })
}

describe('readUserModelSelection', () => {
  it('folds null without events, the selection after armed, null after disarmed', () => {
    const session = Session.create(SessionId('fold'))
    expect(readUserModelSelection(session.events)).toBeNull()
    session.append('user-model/armed', selection)
    expect(readUserModelSelection(session.events)).toEqual(selection)
    session.append('user-model/disarmed', { reason: 'complete' })
    expect(readUserModelSelection(session.events)).toBeNull()
    session.append('user-model/armed', { ...selection, prompt: 'Other goal' })
    expect(readUserModelSelection(session.events)?.prompt).toBe('Other goal')
  })
})

describe('countUserModelReplies', () => {
  it('counts only replies after the last armed event', () => {
    const session = Session.create(SessionId('count'))
    expect(countUserModelReplies(session.events)).toBe(0)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(countUserModelReplies(session.events)).toBe(0)
    appendUserModelReply(session, 'orphan')
    expect(countUserModelReplies(session.events)).toBe(1)
    session.append('user-model/armed', selection)
    expect(countUserModelReplies(session.events)).toBe(0)
    appendUserModelReply(session, 'one')
    appendUserModelReply(session, 'two')
    expect(countUserModelReplies(session.events)).toBe(2)
    session.append('user-model/disarmed', { reason: 'user' })
    expect(countUserModelReplies(session.events)).toBe(0)
  })
})

describe('prompt renderers', () => {
  it('frames the goal behind delimiters and documents the marker', () => {
    const system = renderUserModelSystemPrompt(selection)
    expect(system).toContain(`<goal>\n${selection.prompt}\n</goal>`)
    expect(system).toContain(USER_MODEL_COMPLETE_MARKER)
    expect(system).toContain('role-flipped')
  })

  it('frames questions with their JSON contract', () => {
    const questions: AskUserQuestionItem[] = [{ id: 'q1', question: 'Proceed?' }]
    const prompt = renderUserModelQuestionsPrompt(questions)
    expect(prompt).toContain(JSON.stringify(questions))
    expect(prompt).toContain('"answers"')
  })

  it('frames approvals with and without a description', () => {
    const bare = renderUserModelApprovalPrompt({ tool: 'bash', args: { command: 'ls' } })
    expect(bare).toContain('Tool: bash')
    expect(bare).toContain('Arguments (JSON):')
    expect(bare).not.toContain('Description:')
    const described = renderUserModelApprovalPrompt({ tool: 'bash', args: {}, description: 'lists files' })
    expect(described).toContain('Description: lists files')
    const argsless = renderUserModelApprovalPrompt({ tool: 'bash' })
    expect(argsless).toContain('Tool: bash')
    expect(argsless).not.toContain('Arguments (JSON):')
  })
})

describe('buildUserModelTranscript', () => {
  const history = [
    createUserMessage({ content: [{ type: 'text', text: 'hello agent' }], source: { kind: 'user' } }),
    { ...createUserMessage({ content: [], source: { kind: 'user' } }), role: 'assistant' as const,
      source: { kind: 'model' as const, provider: 'p', model: 'm' },
      content: [
        { type: 'text' as const, text: 'agent reply' },
        { type: 'reasoning' as const, text: 'hidden' },
        { type: 'tool-call' as const, id: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'tool-result' as const, toolCallId: CallId('c1'), content: [{ type: 'text' as const, text: 'out' }] },
        { type: 'tool-result' as const, toolCallId: CallId('c2'), isError: true,
          content: [{ type: 'hologram' } as unknown as ContentBlock] },
      ] },
  ] satisfies import('@deepseek-ai/dsh-llm').Message[]

  it('flips roles and folds non-text blocks to tagged text', () => {
    const transcript = buildUserModelTranscript(history, selection)
    expect(transcript).toHaveLength(2)
    expect(transcript[0]!.role).toBe('assistant')
    expect(transcript[0]!.content).toEqual([{ type: 'text', text: 'hello agent' }])
    expect(transcript[1]!.role).toBe('user')
    const texts = (transcript[1]!.content as Extract<ContentBlock, { type: 'text' }>[]).map(b => b.text)
    expect(texts).toEqual([
      'agent reply',
      '[tool call] bash: {"command":"ls"}',
      '[tool result] out',
      '[tool result, error] [hologram]',
    ])
    expect(transcript[1]!.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-user-model', form: 'relay' })
  })

  it('drops messages left with no visible content and tags unknown blocks', () => {
    const reasoningOnly = {
      ...createUserMessage({ content: [], source: { kind: 'user' } }),
      role: 'assistant' as const,
      source: { kind: 'model' as const, provider: 'p', model: 'm' },
      content: [{ type: 'reasoning' as const, text: 'only' }],
    }
    const future = createUserMessage({
      content: [{ type: 'hologram', payload: 1 } as unknown as ContentBlock],
      source: { kind: 'user' },
    })
    const system = {
      ...createUserMessage({ content: [], source: { kind: 'user' } }),
      role: 'system' as const,
      content: [{ type: 'text' as const, text: 'system prompt' }],
    }
    const transcript = buildUserModelTranscript([reasoningOnly, system, future], selection)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]!.content).toEqual([{ type: 'text', text: '[hologram]' }])
  })
})

describe('parseUserModelReply', () => {
  it('passes plain replies through trimmed', () => {
    expect(parseUserModelReply('  keep going  ')).toEqual({ text: 'keep going', done: false })
  })

  it('detects a bare marker and marker after closing feedback', () => {
    expect(parseUserModelReply(USER_MODEL_COMPLETE_MARKER)).toEqual({ text: '', done: true })
    expect(parseUserModelReply(`well done\n${USER_MODEL_COMPLETE_MARKER}\n`)).toEqual({ text: 'well done', done: true })
  })

  it('rejects content after the marker', () => {
    expect(() => parseUserModelReply(`${USER_MODEL_COMPLETE_MARKER} wait`)).toThrow(UserModelParseError)
  })
})

describe('parseUserModelQuestions', () => {
  const questions: AskUserQuestionItem[] = [
    { id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Free text' },
    { id: 'q3', question: 'Multi', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
  ]

  it('accepts a valid reply, tolerating code fences', () => {
    const raw = '```json\n{"answers":[{"id":"q1","selected":["A"]},{"id":"q2","selected":[],"custom":"sure"},{"id":"q3","selected":["X","Y"]}]}\n```'
    expect(parseUserModelQuestions(raw, questions)).toEqual({
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: [], custom: 'sure' },
        { id: 'q3', selected: ['X', 'Y'] },
      ],
    })
  })

  it('rejects malformed and contract-violating replies', () => {
    const bad = [
      'no json here',
      '{broken',
      '{"answers":}',
      '{"answers":{}}',
      '{"answers":["nope"]}',
      '{"answers":[{"id":"unknown","selected":[]}]}',
      '{"answers":[{"id":"q1","selected":[]},{"id":"q1","selected":[]}]}',
      '{"answers":[{"id":"q1","selected":"A"}]}',
      '{"answers":[{"id":"q1","selected":["A","B"]}]}',
      '{"answers":[{"id":"q1","selected":["C"]}]}',
      '{"answers":[{"id":"q1","selected":["A"]}]}',
    ]
    for (const raw of bad) {
      expect(() => parseUserModelQuestions(raw, questions), raw).toThrow(UserModelParseError)
    }
  })
})

describe('parseUserModelApproval', () => {
  it('parses boolean verdicts', () => {
    expect(parseUserModelApproval('{"approved":true}')).toBe(true)
    expect(parseUserModelApproval('{"approved":false}')).toBe(false)
  })

  it('rejects non-boolean verdicts', () => {
    expect(() => parseUserModelApproval('{"approved":"yes"}')).toThrow(UserModelParseError)
  })
})

/** A fake LLM streaming the given chunks. */
function fakeLlm(chunks: StreamChunk[], onStream?: () => void): Pick<import('@deepseek-ai/dsh-llm').LlmRuntime, 'stream'> {
  return {
    async *stream() {
      for (const chunk of chunks) {
        onStream?.()
        yield chunk
      }
    },
  }
}

/** The canonical text-reply chunk sequence. */
function textChunks(text: string, reason: StreamChunk extends never ? never : { kind: string } = { kind: 'stop' }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: reason as never },
  ]
}

describe('callUserModel', () => {
  const session = () => Session.create(SessionId('call'))

  it('logs the request event and returns the assembled text', async () => {
    const s = session()
    const text = await callUserModel({
      llm: fakeLlm(textChunks('next step')),
      session: s,
      purpose: 'steer',
      provider: selection.provider,
      model: selection.model,
      system: 'persona',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'dsh-user-model' } })],
      maxTokens: 1024,
    })
    expect(text).toBe('next step')
    const request = s.events.find(event => event.type === 'user-model/request')
    expect(request?.data).toMatchObject({ purpose: 'steer', provider: 'anthropic', system: 'persona' })
  })

  it('maps terminal finish reasons to failures', async () => {
    const failure = { message: 'boom', code: 'E' }
    const cases: [StreamChunk[], RegExp][] = [
      [[{ type: 'finish', reason: { kind: 'error', failure } as never }], /boom/],
      [[{ type: 'finish', reason: { kind: 'aborted', failure } as never }], /boom/],
      [[{ type: 'finish', reason: { kind: 'max-tokens' } }], /maxTokens/],
      [[{ type: 'finish', reason: { kind: 'tool-calls' } }], /tool/],
      [[{ type: 'finish', reason: { kind: 'surprise' } as never }], /surprise/],
    ]
    for (const [chunks, pattern] of cases) {
      await expect(callUserModel({
        llm: fakeLlm(chunks), session: session(), purpose: 'question',
        provider: 'p', model: 'm', system: 's', messages: [], maxTokens: 1,
      })).rejects.toThrow(pattern)
    }
  })

  it('rejects tool-call output and empty text', async () => {
    const toolCall: StreamChunk[] = [
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('c'), name: 'bash', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    await expect(callUserModel({
      llm: fakeLlm(toolCall), session: session(), purpose: 'approval',
      provider: 'p', model: 'm', system: 's', messages: [], maxTokens: 1,
    })).rejects.toThrow(/text only/)
    await expect(callUserModel({
      llm: fakeLlm(textChunks('   ')), session: session(), purpose: 'steer',
      provider: 'p', model: 'm', system: 's', messages: [], maxTokens: 1,
    })).rejects.toThrow(/no text/)
  })

  it('honors cancellation before and during the stream', async () => {
    await expect(callUserModel({
      llm: fakeLlm(textChunks('x')), session: session(), purpose: 'steer',
      provider: 'p', model: 'm', system: 's', messages: [], maxTokens: 1,
      signal: AbortSignal.abort(),
    })).rejects.toThrow()
    const controller = new AbortController()
    await expect(callUserModel({
      llm: fakeLlm(textChunks('x'), () => { controller.abort() }), session: session(), purpose: 'steer',
      provider: 'p', model: 'm', system: 's', messages: [], maxTokens: 1,
      signal: controller.signal,
    })).rejects.toThrow()
  })
})

describe('userModelProjection', () => {
  const event = (type: 'user-model/armed' | 'user-model/disarmed' | 'turn/start') => {
    const s = Session.create(SessionId('proj'))
    if (type === 'user-model/armed') s.append(type, selection)
    else if (type === 'user-model/disarmed') s.append(type, { reason: 'user' })
    else s.append(type, { turn: 1 })
    return s.events[0]!
  }

  it('folds armed and disarmed events, keeping reference stability', () => {
    expect(userModelProjection.init()).toBeNull()
    const armed = userModelProjection.apply(userModelProjection.init(), event('user-model/armed'))
    expect(armed).toEqual(selection)
    expect(userModelProjection.apply(armed, event('user-model/armed'))).toBe(armed)
    expect(userModelProjection.apply(armed, event('turn/start'))).toBe(armed)
    expect(userModelProjection.apply(armed, event('user-model/disarmed'))).toBeNull()
    expect(userModelProjection.view(armed)).toEqual(selection)
    expect(userModelProjection.stateVersion).toBe(1)
    expect(userModelProjection.schema.parse(armed)).toEqual(selection)
    expect(userModelProjection.schema.parse(null)).toBeNull()
  })

  it('serves the value through the projection registry when composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin({ name: 'user-model', apply })
    const session = ctx.sessions.create(SessionId('proj-compose'))
    session.append('user-model/armed', selection)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(ctx.sessionProjections.snapshot(session).values['userModel']).toEqual(selection)
    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values['userModel']).toBeUndefined()
  })

  it('leaves composition without a projection registry unaffected', () => {
    const ctx = new Context()
    expect(() => { apply(ctx) }).not.toThrow()
  })
})
