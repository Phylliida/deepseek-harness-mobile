/**
 * The store speaks the library's block vocabulary.
 *
 * A transcript reaches memory formation twice over: the library prices it and
 * cuts it into chunks from the store, and it renders it back into the request the
 * summarizer answers. Both read the *membrane* names for a tool call, a tool
 * result and a thought. A store holding the harness's names instead prices those
 * blocks at zero tokens, matches no tool pair, and renders each one to the
 * summarizer as an omission placeholder — so a tool-heavy session compresses as
 * though the tools had never happened. These cases pin the vocabulary where it
 * can fail: in the price, and in the request a driven pass actually sends.
 */

import { MessageStore } from '@animalabs/context-manager'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import { describe, expect, it, vi } from 'vitest'
import AutobiographicalCompactionEngine from '../src/index.ts'
import { seedFromLog } from '../src/seed.ts'
import { createStore } from '../src/store.ts'
import { provideTokenMeter, summarizer } from './harness.ts'

const ROUTE = { provider: 'test', model: 'test-model' }

/** The one tool every round calls, declared the way a request header declares it. */
const TOOL: ToolSchema = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/**
 * A session whose every node is a block the library has to price: a thought and a
 * call on the assistant node, a result carrying text on the `tool/result` node.
 * None of it is text the harness and the library would name alike, so a store
 * speaking the wrong vocabulary prices the whole transcript at zero.
 *
 * `declareTools` is off for the session that never logged what its tools were —
 * a request header carrying no tools, which is how the library learns them.
 */
function toolTranscript(id: string, rounds: number, declareTools = true): Session {
  const session = Session.create(SessionId(id))
  session.append('request/context', { provider: ROUTE.provider, model: ROUTE.model, contextWindow: 100_000 })
  if (declareTools) {
    session.append('request/header', { header: { config: ROUTE, tools: [TOOL] }, reason: 'initial' })
  }
  for (let round = 0; round < rounds; round++) {
    session.append('turn/start', { turn: round })
    const callId = CallId(`call-${round}`)
    session.append('assistant/message', {
      turn: round,
      step: 0,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: `weighing read ${round} ${'y'.repeat(300)}` },
          { type: 'tool-call', id: callId, name: 'read', arguments: `{"path":"file-${round}.ts"}` },
        ],
        source: ROUTE,
      }),
      usage: { inputTokens: 1000, outputTokens: 100 },
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: round,
      step: 0,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `read ${round} ${'z'.repeat(300)}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: round, reason: { kind: 'completed' } })
  }
  return session
}

/** An engine over a transcript, driven through six passes the way a live session drives it. */
async function driven(session: Session): Promise<GenerateOptions[]> {
  const calls: GenerateOptions[] = []
  const ctx = new Context()
  ctx.provide('llm', summarizer(calls) as never)
  provideTokenMeter(ctx)
  const engine = new AutobiographicalCompactionEngine(ctx, {
    operatingWindowTokens: 700,
    reserveTokens: 128,
    auto: false,
    // The strategy only cuts a chunk out of history it considers aged, and the
    // default recent window is larger than any fixture here.
    strategy: { recentWindowTokens: 0 },
  })
  const agent = {
    session,
    options: ROUTE,
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  } as CompactionAgentContext
  for (let pass = 0; pass < 6; pass++) {
    await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return calls
}

describe('a seeded transcript prices in the library\'s vocabulary', () => {
  it('prices a thought, a call and a nested result above zero', () => {
    const store = createStore()
    seedFromLog(store, toolTranscript('acceptance-vocabulary-price', 2))
    const messages = new MessageStore(store as never)

    // Every stored message carries only blocks the harness names one way and the
    // library another, so a zero here is the whole transcript priced away.
    const priced = messages.getAll().map(message => messages.estimateTokens(message))
    expect(priced).toHaveLength(4)
    for (const tokens of priced) expect(tokens).toBeGreaterThan(0)
  })
})

describe('a driven memory-formation request carries the tools', () => {
  it('asks the summarizer about the calls and results, not about omitted placeholders', async () => {
    const calls = await driven(toolTranscript('acceptance-vocabulary-request', 30))
    expect(calls.length).toBeGreaterThan(0)

    const blocks = calls[0]?.messages.flatMap((message: Message) => message.content) ?? []
    const types = blocks.map(block => block.type)
    // Rounds of the transcript reach the summarizer as their own call and their
    // own result, with the tools the request was declared with. How many rounds a
    // chunk holds depends on the tick schedule, so the counts are not the claim.
    expect(types).toContain('tool-call')
    expect(types).toContain('tool-result')
    expect(calls[0]?.tools?.map(tool => tool.name)).toEqual(['read'])
    // Every omission either side can render: this backend's placeholder for a
    // block in the harness's vocabulary, and the library's own stub for a half of
    // a tool pair it could not match.
    const text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).not.toMatch(/omitted from memory|tool call omitted|tool result unavailable/)
  })

  it('defers the chunk when the session logged no tools, which is the tools being seen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = await driven(toolTranscript('acceptance-vocabulary-undeclared', 30, false))
    const logged = warn.mock.calls.flat().join('\n')
    warn.mockRestore()

    // The library holds back a chunk whose blocks include a call or a result until
    // the host has pushed the tool definitions they belong to, because a tools-less
    // replay of a tool transcript reads as a foreign agent trace. It can only hold
    // back for blocks it can name: under the harness's vocabulary it sees none.
    expect(logged).toMatch(/deferring chunk compression.*history contains tool blocks/)
    expect(calls).toHaveLength(0)
  })
})
