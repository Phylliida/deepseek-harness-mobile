/**
 * The invariant the widening pass exists to hold, checked on the surface the
 * engine leaves behind rather than on the folds it planned: every tool call a
 * model can still see has its result, and every result it can still see has its
 * call. A fold cutting between the two orphans one of them, and the wire then
 * carries an unanswered `tool_calls`, which providers reject.
 *
 * The transcript is the shape the harness writes — the call on the assistant
 * node, the result on the `tool/result` node after it — so a boundary between
 * them is a real possibility. `plan.spec.ts` proves widening on a hand-built
 * surface; these cases prove the surface the engine actually leaves is
 * pair-safe after it, which is the property the rest of the design leans on.
 */

import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import type { SummaryEntry } from '@animalabs/context-manager'
import { describe, expect, it } from 'vitest'
import AutobiographicalCompactionEngine from '../src/index.ts'
import { planFolds, priceSurfaceNode } from '../src/plan.ts'
import { seedFromLog } from '../src/seed.ts'
import { LogStore, MESSAGES_STATE } from '../src/store.ts'
import { provideTokenMeter, summarizer } from './harness.ts'

const ROUTE = { provider: 'test', model: 'test-model' }

/** One assistant turn that asks for a tool, and the result that answers it. */
function round(session: Session, turn: number): { call: number; result: number } {
  const callId = CallId(`call-${turn}`)
  const call = session.append('assistant/message', {
    turn,
    step: 0,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: `asking ${turn} ${'y'.repeat(300)}` },
        { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"a.ts"}' },
      ],
      source: ROUTE,
    }),
    usage: { inputTokens: 1000, outputTokens: 100 },
  }, { surfaceOp: 'append' }).seq
  const result = session.append('tool/result', {
    turn,
    step: 0,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: `read ${turn} ${'z'.repeat(300)}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
  return { call, result }
}

/** The one tool every round calls, declared the way a request header declares it. */
const TOOL: ToolSchema = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/** A transcript where every turn asks for a tool and is answered. */
function toolTranscript(id: string, turns: number): { session: Session; pairs: Map<string, { call: number; result: number }> } {
  const session = Session.create(SessionId(id))
  const pairs = new Map<string, { call: number; result: number }>()
  session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
  // The header a real session logs, and the only way the strategy learns the
  // session's tools: with tool blocks in history but no definitions pushed, it
  // defers every tool-bearing chunk rather than replay a tool transcript without
  // its tools.
  session.append('request/header', {
    header: { config: { provider: 'test', model: 'test-model' }, tools: [TOOL] },
    reason: 'initial',
  })
  for (let turn = 0; turn < turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `ask ${turn} ${'x'.repeat(400)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const one = round(session, turn)
    pairs.set(`call-${turn}`, one)
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { session, pairs }
}

/** An engine over a tool transcript, with the same shape `harness.build` gives. */
function toolEngine(id: string, turns: number): {
  engine: AutobiographicalCompactionEngine
  agent: CompactionAgentContext
  session: Session
  pairs: Map<string, { call: number; result: number }>
} {
  const { session, pairs } = toolTranscript(id, turns)
  const calls: never[] = []
  const ctx = new Context()
  ctx.provide('llm', summarizer(calls as never) as never)
  provideTokenMeter(ctx)
  const engine = new AutobiographicalCompactionEngine(ctx, {
    operatingWindowTokens: 700,
    reserveTokens: 128,
    auto: false,
    strategy: { recentWindowTokens: 0 },
  })
  const agent = {
    session,
    options: ROUTE,
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  } as CompactionAgentContext
  return { engine, agent, session, pairs }
}

/** The message a surface node carries, when it carries one. */
function eventMessage(event: SessionEvent): Message | undefined {
  return (event.data as { readonly message?: Message }).message
}

/** Call ids and result ids on the nodes a model would still be shown. */
function visible(session: Session): { calls: Set<string>; results: Set<string> } {
  const events = new Map(session.events.map(event => [event.seq, event]))
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const seq of session.surface.nodes) {
    const event = events.get(seq)
    for (const block of (event === undefined ? undefined : eventMessage(event))?.content ?? []) {
      if (block.type === 'tool-call') calls.add(block.id)
      if (block.type === 'tool-result') results.add(block.toolCallId)
    }
  }
  return { calls, results }
}

/** Every visible call answered, and every visible result grounded. */
function orphans(session: Session): { unanswered: string[]; ungrounded: string[] } {
  const { calls, results } = visible(session)
  return {
    unanswered: [...calls].filter(id => !results.has(id)),
    ungrounded: [...results].filter(id => !calls.has(id)),
  }
}

describe('a fold never splits a tool pair', () => {
  it('folds a tool transcript and leaves no orphaned call or result', async () => {
    const { engine, agent, session, pairs } = toolEngine('pair-settled', 30)
    for (let pass = 0; pass < 6; pass++) {
      await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(pairs.size).toBe(30)
    expect(session.surface.nodes.length).toBeLessThan(pairs.size * 2)
    expect(orphans(session)).toEqual({ unanswered: [], ungrounded: [] })
  })

  it('holds the invariant after every pass, not only at the end', async () => {
    const { engine, agent, session } = toolEngine('pair-each-pass', 30)

    // A straddle would have to be introduced by one pass and never repaired. The
    // end state alone cannot show that: a later fold could absorb the orphan.
    for (let pass = 0; pass < 6; pass++) {
      await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect({ pass, ...orphans(session) }).toEqual({ pass, unanswered: [], ungrounded: [] })
    }
  })

  it('takes a pair as a whole: a covered call covers its result', async () => {
    const { engine, agent, session, pairs } = toolEngine('pair-whole', 30)
    for (let pass = 0; pass < 6; pass++) {
      await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    // Not "no orphans" but the stronger per-pair claim: the two nodes of a round
    // are both folded or both standing. A fold that covered the call node alone
    // would be answering a request the model can no longer see, and one that
    // covered the result alone would leave a call it cannot get an answer to.
    const surface = new Set(session.surface.nodes)
    for (const [id, pair] of pairs) {
      const both = [pair.call, pair.result].map(seq => surface.has(seq))
      expect({ id, both }).toEqual({ id, both: [both[0], both[0]] })
    }
  })

  // The end-to-end cases above can pass on a transcript whose folds happen to
  // land on round boundaries. This one puts a recollection's coverage exactly on
  // the result of a round, which is the arrangement that needs widening, and
  // asserts the plan reaches back for the call.
  it('reaches the call of a recollection that starts on a result', () => {
    const { op, call, result } = foldOver('widen-backward', 10, 15)
    expect({ call, result, covered: [op.shadowedSeqs.includes(call), op.shadowedSeqs.includes(result)] })
      .toEqual({ call, result, covered: [true, true] })
  })

  // A round that fans out: one node asks for two tools and each result lands on a
  // node of its own, so a recollection starting at the second result has its call
  // node two nodes back. A one-node reach takes the results and leaves the calls
  // visible, which is the unanswered `tool_calls` providers reject.
  it('keeps a parallel round whole when the fold starts at its second result', () => {
    const { session, pairs } = parallelTranscript('widen-parallel', 4)
    const store = new LogStore()
    const { seqOf } = seedFromLog(store, session)
    const mirrored = store.getStateJson(MESSAGES_STATE) as { id: string; metadata?: Record<string, unknown> }[]
    // The second result of the first round, and nothing else: the tail of a round
    // the recollection begins inside.
    const second = pairs.get('call-0')?.second as number
    const covered = mirrored.filter(message => Number(message.metadata?.['dshSeq']) === second)
    const summary = {
      id: 'L1-0',
      level: 1,
      content: 'recalled',
      tokens: 5,
      created: 1,
      sourceIds: covered.map(message => message.id),
    } as unknown as SummaryEntry
    const [op] = planFolds(store, session, {
      resolutions: new Map(covered.map(message => [message.id, 1])),
      summaries: [summary],
      seeded: new Map(),
      seqOf,
      price: priceSurfaceNode,
    })
    if (op === undefined) throw new Error('the parallel-round fixture produced no fold')
    const round = pairs.get('call-0') as { first: number; second: number; call: number }
    // Both calls, both results and the node declaring them, so the landed fold
    // leaves no call visible without its tool message.
    expect(op.shadowedSeqs).toEqual([round.call, round.first, round.second])
  })

  // The mirror arrangement is unreachable, and that is a property of the
  // coverage the planner reasons with rather than an untested branch: coverage
  // comes from the messages a recollection cites, a message answers at most one
  // call, and a call and its result are separate messages. So a covered run that
  // takes a call takes the message holding it whole — with its result — and a run
  // that ends on a call cannot exist. Widening forward is defensive against
  // coverage read some other way, and `plan.spec.ts` covers it on a
  // hand-built surface.
  it('takes the result with the call when coverage lands on one', () => {
    const { op, call, result } = foldOver('pair-atomic', 9, 9)
    expect(op.shadowedSeqs).toEqual([call, result])
  })
})

/**
 * A transcript of parallel rounds: `call-n` asks for two tools on one node and
 * each result lands on a node of its own. Rounds are five log seqs apart — ask,
 * call, first result, second result, boundary marker — so a case can name the
 * second result of a round by its seq.
 */
function parallelTranscript(id: string, turns: number): {
  session: Session
  pairs: Map<string, { call: number; first: number; second: number }>
} {
  const session = Session.create(SessionId(id))
  const pairs = new Map<string, { call: number; first: number; second: number }>()
  session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
  session.append('request/header', {
    header: { config: { provider: 'test', model: 'test-model' }, tools: [TOOL] },
    reason: 'initial',
  })
  for (let turn = 0; turn < turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `ask ${turn} ${'x'.repeat(200)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const call = session.append('assistant/message', {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: `asking twice ${'y'.repeat(200)}` },
          { type: 'tool-call', id: CallId(`call-${turn}`), name: 'read', arguments: '{"path":"a.ts"}' },
          { type: 'tool-call', id: CallId(`call-${turn}-b`), name: 'read', arguments: '{"path":"b.ts"}' },
        ],
        source: ROUTE,
      }),
      usage: { inputTokens: 1000, outputTokens: 100 },
    }, { surfaceOp: 'append' }).seq
    const first = session.append('tool/result', {
      turn,
      step: 0,
      message: createToolResultMessage({
        callId: CallId(`call-${turn}`),
        content: [{ type: 'text', text: `read ${turn} ${'z'.repeat(200)}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq
    const second = session.append('tool/result', {
      turn,
      step: 0,
      message: createToolResultMessage({
        callId: CallId(`call-${turn}-b`),
        content: [{ type: 'text', text: `read ${turn} again ${'z'.repeat(200)}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq
    pairs.set(`call-${turn}`, { call, first, second })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { session, pairs }
}

/**
 * One fold over a recollection covering log seqs `from..to` of a tool
 * transcript, with the pair that range starts on reported so a case can name what
 * it expects. Round `n` asks on seq `5n + 3`, calls on `5n + 4` and is answered
 * on `5n + 5`.
 */
function foldOver(id: string, from: number, to: number): {
  op: NonNullable<ReturnType<typeof planFolds>[number]>
  call: number
  result: number
} {
  const { session, pairs } = toolTranscript(id, 6)
  const store = new LogStore()
  const { seqOf } = seedFromLog(store, session)
  const mirrored = store.getStateJson(MESSAGES_STATE) as { id: string; metadata?: Record<string, unknown> }[]
  const covered = mirrored.filter((message) => {
    const seq = Number(message.metadata?.['dshSeq'])
    return seq >= from && seq <= to
  })
  const summary = {
    id: 'L1-0',
    level: 1,
    content: 'recalled',
    tokens: 5,
    created: 1,
    sourceIds: covered.map(message => message.id),
  } as unknown as SummaryEntry
  const out = planFolds(store, session, {
    resolutions: new Map(covered.map(message => [message.id, 1])),
    summaries: [summary],
    seeded: new Map(),
    seqOf,
    price: priceSurfaceNode,
  })[0]
  if (out === undefined) throw new Error(`fixture ${id} produced no fold`)
  const pair = [...pairs.values()].find(one => one.call === from || one.result === from)
  if (pair === undefined) throw new Error(`fixture ${id} lost the pair at ${from}`)
  return { op: out, call: pair.call, result: pair.result }
}
