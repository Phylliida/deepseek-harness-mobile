/**
 * Planning: resolutions and the surface turned into folds.
 *
 * `planFolds` is a pure function of the store, the log, and what the strategy
 * committed, so the fixtures build the session by hand, seed a store from it,
 * and drive the planner directly. The engine specs prove the pass wires planning
 * up; these prove the planning — including the widening that keeps a fold from
 * cutting a tool round in half.
 */

import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/src/estimate.ts'
import type { SummaryEntry } from '@animalabs/context-manager'
import type { ContentBlock as MembraneBlock } from '@animalabs/membrane'
import { describe, expect, it } from 'vitest'
import { DivergenceError, foldBlocks, foldIdOf, planFolds, priceSurfaceNode } from '../src/plan.ts'
import type { FoldOp, PlanInputs } from '../src/plan.ts'
import type { RecollectionRange } from '../src/types.ts'
import { SessionEvent } from '@deepseek-ai/dsh-session'
import { seedFromLog } from '../src/seed.ts'
import { LogStore, MESSAGES_STATE } from '../src/store.ts'

const ROUTE = { provider: 'test', model: 'test-model' }

/** A recollection carrying the fields planning reads. */
function summary(id: string, level: number, overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id, level, content: `content of ${id}`, tokens: 12, created: 1_700_000_000_000,
    sourceLevel: 0, sourceIds: [], sourceRange: { first: id, last: id },
    ...overrides,
  }
}

function started(id: string): Session {
  const live = Session.create(SessionId(id))
  live.append('turn/start', { turn: 0 })
  return live
}

function userEvent(live: Session, text: string): number {
  return live.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function textEvent(live: Session, text: string, step = 0): number {
  return live.append('assistant/message', {
    turn: 0,
    step,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: ROUTE }),
  }, { surfaceOp: 'append' }).seq
}

/** One tool round: the assistant asks, the tool answers, on two nodes. */
function toolRound(live: Session, id: string, step = 0): { call: number; result: number } {
  const call = live.append('assistant/message', {
    turn: 0,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool-call', id: CallId(id), name: 'read', arguments: '{}' },
      ],
      source: ROUTE,
    }),
  }, { surfaceOp: 'append' }).seq
  const result = live.append('tool/result', {
    turn: 0,
    step,
    message: createToolResultMessage({ callId: CallId(id), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' }).seq
  return { call, result }
}

/**
 * One parallel tool round: the assistant declares two calls on one node, and
 * each result lands on its own node after it. The shape a fan-out takes, and the
 * one whose results a recollection can start in the middle of.
 */
function parallelRound(live: Session, ids: readonly string[], step = 1): { call: number; results: number[] } {
  const call = live.append('assistant/message', {
    turn: 0,
    step,
    message: createAssistantMessage({
      content: [
        { type: 'text', text: 'let me look twice' },
        ...ids.map(id => ({ type: 'tool-call' as const, id: CallId(id), name: 'read', arguments: '{}' })),
      ],
      source: ROUTE,
    }),
  }, { surfaceOp: 'append' }).seq
  const results = ids.map(id => live.append('tool/result', {
    turn: 0,
    step,
    message: createToolResultMessage({ callId: CallId(id), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' }).seq)
  return { call, results }
}

/**
 * A landed fold node replacing a span of log seqs — the same thing `applyFold`
 * writes, so the fixture cannot drift from what the engine produces.
 */
function foldNode(live: Session, id: string, sources: number[]): SessionEvent {
  // start/end are surface positions, not log seqs: a landed fold node's seq is
  // newer than the ground it stands in front of, so min/max over the seqs
  // alone inverts the range once a fold replaces another fold.
  const nodes = live.surface.nodes
  const positions = sources.map(seq => nodes.indexOf(seq)).filter(at => at >= 0)
  return live.append('assistant/message', {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `[Recall ${id}]\n\ncontent of ${id}` }],
      source: { ...ROUTE, compactionId: `autobio:${id}` },
    }),
  }, { surfaceOp: { op: 'replace', start: nodes[Math.min(...positions)]!, end: nodes[Math.max(...positions)]! }, sourceEventSeqs: sources })
}

/** A store seeded from the log, as the engine's open path builds it. */
/** A seeded recollection whose covered and cited spans are the same interval. */
function span(firstSeq: number, lastSeq: number): RecollectionRange {
  return { covered: { firstSeq, lastSeq }, cited: { firstSeq, lastSeq } }
}

function seeded(live: Session): { store: LogStore; seqOf: Map<string, number>; known: Map<string, RecollectionRange> } {
  const store = new LogStore()
  const { seqOf, known } = seedFromLog(store, live)
  return { store, seqOf, known }
}

/** The mirrored message ids, in store position order. */
function mirrored(store: LogStore): string[] {
  return (store.getStateJson(MESSAGES_STATE) as Record<string, unknown>[]).map(message => String(message['id']))
}

/**
 * Resolve every mirrored message to the recollection standing over it, which is
 * what a compile commits. A fixture sets resolutions directly only to reach a
 * layout the picker would refuse to commit.
 */
function resolvedBy(
  seqOf: ReadonlyMap<string, number>,
  summaries: readonly SummaryEntry[],
  ranges: ReadonlyMap<string, RecollectionRange>,
  ids: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const id of ids) {
    const seq = seqOf.get(id)
    if (seq === undefined) continue
    for (const entry of summaries) {
      const range = ranges.get(entry.id)
      if (range !== undefined && range.covered.firstSeq <= seq && range.covered.lastSeq >= seq) {
        out.set(id, entry.level)
        break
      }
    }
  }
  return out
}

/**
 * Plan against the store the engine would have opened for this log.
 *
 * Without `ranges`, every recollection is taken to stand over the whole
 * replayed history — the transcript fixtures hold no mint events, so the log
 * records no range and the store is the only account of the ground. Tests that
 * turn on a narrower footprint say so.
 */
function plan(
  live: Session,
  opts: {
    store?: LogStore
    seqOf?: Map<string, number>
    /** Log-derived ranges to override, keyed by recollection id. */
    ranges?: Map<string, RecollectionRange>
    level?: number
    resolutions?: Map<string, number>
    summaries?: SummaryEntry[]
  } = {},
): FoldOp[] {
  const base = seeded(live)
  const store = opts.store ?? base.store
  const seqOf = opts.seqOf ?? base.seqOf
  const seqs = mirrored(store).flatMap(id => seqOf.get(id) ?? [])
  const summaries = opts.summaries ?? []
  // A fixture's recollections are seeded from the log's own fold events, so the
  // ground they stand over and the interval they cite are the same span here.
  const coverage = opts.ranges ?? new Map(summaries.map((entry) => {
    const span = { firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) }
    return [entry.id, { covered: span, cited: span }]
  }))
  const inputs: PlanInputs = {
    // Derived rather than declared: a resolution lands on the messages a
    // recollection covered, so a fixture that names both independently could
    // describe a layout no compile produces and then assert on it.
    resolutions: opts.resolutions ?? (opts.level === undefined
      ? resolvedBy(seqOf, summaries, coverage, mirrored(store))
      : new Map(mirrored(store).map(id => [id, opts.level as number]))),
    summaries,
    seeded: coverage,
    seqOf,
    // The fixture's surface is priced the way the engine prices it, so a test
    // that reads a token count reads the meter's own number.
    price: priceSurfaceNode,
  }
  return planFolds(store, live, inputs)
}

describe('fold identity', () => {
  it('names the error, so a caught divergence reads as one', () => {
    expect(new DivergenceError('mismatch').name).toBe('DivergenceError')
  })

  it('reads the recollection off the model source, and only off a model source', () => {
    const live = Session.create(SessionId('plan-fold-id'))
    const ask = userEvent(live, 'ask')
    foldNode(live, 'L1-0', [ask])

    const node = live.events.at(-1)
    expect(node === undefined ? undefined : foldIdOf(node)).toBe('L1-0')
    expect(foldIdOf(live.events.find(event => event.seq === ask)!)).toBeUndefined()
  })
})

describe('foldBlocks', () => {
  it('replays captured reasoning verbatim, signatures and all', () => {
    const captured: ContentBlock[] = [
      { type: 'reasoning', text: 'private thinking', signature: 'sig' } as ContentBlock,
      { type: 'text', text: 'the answer' },
    ]
    // The strategy keeps whatever the provider streamed; the harness block is the
    // one that has to survive the round trip, signature and all.
    const replayed = foldBlocks(summary('L1-0', 1, { responseContent: captured as MembraneBlock[] }))
    expect(replayed).toBe(captured)
    expect(replayed[0]).toMatchObject({ type: 'reasoning', signature: 'sig' })
  })

  it('falls back to a headed text block when there is nothing captured', () => {
    expect(foldBlocks(summary('L1-0', 1))).toEqual([
      { type: 'text', text: '[Recall L1-0]\n\ncontent of L1-0' },
    ])
  })
})

describe('priceSurfaceNode', () => {
  it('prices a tool round the way the token meter prices the same nodes', () => {
    const live = started('plan-price')
    const ask = userEvent(live, 'ask')
    const round = toolRound(live, 'call-price', 1)
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)
    const [op] = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map(ids.map(id => [id, 1])),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, round.result)]]),
      seqOf,
    })

    // What the meter prices the shadowed nodes at, node for node.
    const events = new Map(live.events.map(event => [event.seq, event]))
    const priced = (op?.shadowedSeqs ?? []).reduce((total, seq) => {
      const event = events.get(seq)
      return total + estimateMessage((event === undefined ? null : deriveEventMessage(event)) as never)
    }, 0)
    // Exactly the meter's own reading of the same nodes, because the fold's
    // shadow price is subtracted from a surface the meter priced: a cheaper claim
    // would report every fold as a shrinkage it did not achieve, and the old
    // text-only price put a tool round at a fraction of this.
    expect(op?.shadowedTokens).toBe(priced)
  })
})

describe('planFolds', () => {
  it('folds nothing when nothing is resolved', () => {
    const live = started('plan-nothing')
    userEvent(live, 'ask')
    textEvent(live, 'answer')

    expect(plan(live)).toEqual([])
  })

  it('folds the live span of one recollection into one op', () => {
    const live = started('plan-one')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    const ops = plan(live, {
      level: 1,
      summaries: [summary('L1-0', 1)],
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ summaryId: 'L1-0', level: 1, startSeq: ask, endSeq: answer, shadowedSeqs: [ask, answer] })
    expect(ops[0]?.shadowedTokens).toBeGreaterThan(0)
  })

  it('skips a mirrored message whose seq metadata is missing or nonsense', () => {
    const live = started('plan-seq')
    userEvent(live, 'ask')
    textEvent(live, 'answer')

    const { store, seqOf, known } = seeded(live)
    const rows = store.getStateJson(MESSAGES_STATE) as Record<string, unknown>[]
    // Every message is resolved, so the only reason to fold nothing is metadata.
    const resolutions = resolvedBy(seqOf, [summary('L1-0', 1)], new Map([['L1-0', span(1, 2)]]), mirrored(store))
    const withMetadata = (metadata: Record<string, unknown>, at: number): FoldOp[] => {
      store.setStateJson(MESSAGES_STATE, rows.map((row, index) => index === at ? { ...row, metadata } : row))
      return planFolds(store, live, {
        resolutions,
        summaries: [summary('L1-0', 1)],
        seeded: new Map([...known, ['L1-0', span(1, 2)]]),
        seqOf,
        price: priceSurfaceNode,
      })
    }

    // The control proves the fixture folds both messages; each rejection then
    // proves the unreadable one is left alone rather than folded to nothing.
    expect(withMetadata({ dshSeq: 1 }, 0)[0]?.shadowedSeqs).toEqual([1, 2])
    for (const metadata of [{}, { dshSeq: '1' }, { dshSeq: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect(withMetadata(metadata, 1)[0]?.shadowedSeqs).toEqual([1])
    }
  })

  it('throws DivergenceError when no recollection of the resolved level stands for a message', () => {
    const live = started('plan-diverged')
    userEvent(live, 'ask')
    textEvent(live, 'answer')

    // Resolved at level 2 with only an L1 minted: the picker and the planner
    // disagree about the pyramid, which is a bug and not a layout to work around.
    expect(() => plan(live, { level: 2, summaries: [summary('L1-0', 1)] })).toThrow(DivergenceError)
  })

  it('lets a merged recollection stand until the fold of its parent lands', () => {
    const live = started('plan-merged-unlanded')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    // `mergedInto` records formation, not representation: the parent's fold has
    // not landed, so the child's node is still what the surface shows for this
    // ground, and passing the child over would throw where a fold is exactly
    // right. The case pins both pointer spellings, because the library writes
    // `mergedInto` (deprecated) live and reads `parentId` as the alias.
    const ops = plan(live, {
      level: 1,
      summaries: [
        summary('L1-0', 1, { parentId: 'L2-0' }),
        // oxlint-disable-next-line typescript/no-deprecated -- the legacy alias this case pins
        summary('L1-1', 1, { mergedInto: 'L2-0' }),
      ],
      ranges: new Map([['L1-1', span(ask, answer)]]),
    })

    expect(ops.map(op => op.summaryId)).toEqual(['L1-1'])
  })

  it('takes the recollection that stands over the message, not the level alone', () => {
    const live = started('plan-stands')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    // Two L1s at one level: only the one whose coverage holds the message counts.
    const ops = plan(live, {
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      ranges: new Map([['L1-1', span(ask, answer)]]),
    })

    expect(ops.map(op => op.summaryId)).toEqual(['L1-1'])
  })

  it('merges a recollection whose run is split by another fold into one op', () => {
    const live = started('plan-merge')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const reply = userEvent(live, 'reply')

    // The last message resolves higher, so L1-0's run is cut in two and has to
    // come back together by id — a surface carrying the same recollection twice
    // is exactly what the merge exists to prevent.
    const { store, seqOf, known } = seeded(live)
    const ids = mirrored(store)
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1], [ids[2]!, 2]]),
      summaries: [summary('L1-0', 1), summary('L1-1', 2)],
      seeded: new Map([...known, ['L1-0', span(ask, answer)], ['L1-1', span(reply, reply)]]),
      seqOf,
    })

    expect(ops.map(op => op.summaryId).sort()).toEqual(['L1-0', 'L1-1'])
    expect(ops.find(op => op.summaryId === 'L1-0')?.shadowedSeqs).toEqual([ask, answer])
    expect(ops.find(op => op.summaryId === 'L1-1')?.shadowedSeqs).toEqual([reply])
  })

  it('does not fold a recollection the surface already carries', () => {
    const live = started('plan-landed')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf, known } = seeded(live)
    foldNode(live, 'L1-0', [ask, answer])
    const ops = plan(live, {
      store,
      seqOf,
      summaries: [summary('L1-0', 1)],
      ranges: new Map([...known, ['L1-0', span(ask, answer)]]),
    })

    expect(ops).toEqual([])
  })

  it('stops folding a recollection once a landed parent stands for its ground', () => {
    const live = started('plan-parent-landed')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const reply = userEvent(live, 'reply')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // The reported cycle: the child landed, then the parent landed over the
    // child's node and the reply. The surface's one node now stands for the
    // child's ground plus more, so neither level has anything left to fold —
    // and a claim for the child is dropped rather than folded a second time.
    const child = foldNode(live, 'L1-0', [ask, answer])
    foldNode(live, 'L2-6', [child.seq, reply])
    const ops = plan(live, {
      store,
      seqOf,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1], [ids[2]!, 2]]),
      summaries: [summary('L1-0', 1, { parentId: 'L2-6' }), summary('L2-6', 2)],
      ranges: new Map([['L1-0', span(ask, answer)], ['L2-6', span(ask, reply)]]),
    })

    expect(ops).toEqual([])
  })

  it('stops at the top of a chain of landed ancestors', () => {
    const live = started('plan-chain-landed')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const reply = userEvent(live, 'reply')
    const more = textEvent(live, 'more')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // L1-0 landed, L2-6 landed over it and the reply, L3-43 landed over both
    // and the last message. No pyramid pointer is read to settle this: the top
    // node stands for every level's ground, and that is the whole answer.
    const child = foldNode(live, 'L1-0', [ask, answer])
    const parent = foldNode(live, 'L2-6', [child.seq, reply])
    foldNode(live, 'L3-43', [parent.seq, more])
    const ops = plan(live, {
      store,
      seqOf,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1], [ids[2]!, 2], [ids[3]!, 3]]),
      summaries: [
        summary('L1-0', 1, { parentId: 'L2-6' }),
        summary('L2-6', 2, { parentId: 'L3-43' }),
        summary('L3-43', 3),
      ],
      ranges: new Map([
        ['L1-0', span(ask, answer)],
        ['L2-6', span(ask, reply)],
        ['L3-43', span(ask, more)],
      ]),
    })

    expect(ops).toEqual([])
  })

  it('drops a claim whose ground a landed parent already replaced, though it never landed itself', () => {
    const live = started('plan-parent-only')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const reply = userEvent(live, 'reply')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // L1-0 never landed; L2-6 folded the raw span directly. The child's claim
    // would shadow ground the parent's node already replaced, so it is dropped
    // where the claims are built rather than reaching the surface.
    foldNode(live, 'L2-6', [ask, answer, reply])
    const ops = plan(live, {
      store,
      seqOf,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1], [ids[2]!, 2]]),
      summaries: [summary('L1-0', 1, { parentId: 'L2-6' }), summary('L2-6', 2)],
      ranges: new Map([['L1-0', span(ask, answer)], ['L2-6', span(ask, reply)]]),
    })

    expect(ops).toEqual([])
  })

  it('ignores an empty assistant step, which carries usage but no content', () => {
    const live = started('plan-empty')
    const ask = userEvent(live, 'ask')
    textEvent(live, 'answer')
    live.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({ content: [], source: ROUTE }),
    }, { surfaceOp: 'append' })

    const ops = plan(live, {
      summaries: [summary('L1-0', 1)],
      ranges: new Map([['L1-0', span(ask, ask + 1)]]),
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, ask + 1])
  })

  it('widens backward over the call that answers the fold', () => {
    const live = started('plan-back')
    const { call, result } = toolRound(live, 'call-back')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // The recollection landed on the result alone — the call is a node the fold
    // begins after, and taking the result without it would leave half a round.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(result, result)]]),
      seqOf,
    })

    expect(ops[0]?.startSeq).toBe(call)
    expect(ops[0]?.shadowedSeqs).toEqual([call, result])
  })

  it('spans two runs of one recollection as one fold', () => {
    const live = started('plan-split')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // The picker resolved both messages at level 1 and remembered them as one
    // recollection, so the two runs coalesce rather than folding twice.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    expect(ops).toHaveLength(1)
    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it('widens forward over the result that answers the fold', () => {
    const live = started('plan-forward')
    const ask = userEvent(live, 'ask')
    const { call, result } = toolRound(live, 'call-forward', 1)

    const ops = plan(live, {
      summaries: [summary('L1-0', 1)],
      ranges: new Map([['L1-0', span(ask, call)]]),
    })

    expect(ops[0]?.endSeq).toBe(result)
    expect(ops[0]?.shadowedSeqs).toEqual([ask, call, result])
  })

  it('leaves a fold alone when nothing around it needs widening', () => {
    const live = started('plan-plain')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    const ops = plan(live, {
      level: 1,
      summaries: [summary('L1-0', 1)],
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it('stops widening at a node that asks as well as answers', () => {
    const live = started('plan-break')
    const ask = userEvent(live, 'ask')
    const { call } = toolRound(live, 'call-break', 1)
    // The round's result lands inside the fold's reach, and the node after it
    // holds a result *and* a call the fold does not reach — the shape a plugin or
    // subagent turn takes. Taking it would orphan `call-unreached`, so the walk
    // stops with the round whole.
    const mixed = live.append('assistant/message', {
      turn: 0,
      step: 2,
      message: createAssistantMessage({
        content: [
          { type: 'tool-result', toolCallId: CallId('call-break'), content: [{ type: 'text', text: 'ok' }] },
          { type: 'tool-call', id: CallId('call-unreached'), name: 'read', arguments: '{}' },
        ],
        source: ROUTE,
      }),
    }, { surfaceOp: 'append' }).seq

    const ops = plan(live, {
      summaries: [summary('L1-0', 1)],
      ranges: new Map([['L1-0', span(ask, call)]]),
    })

    // The span covers the round's own result and stops short of the mixed node.
    expect(ops[0]?.shadowedSeqs).toEqual([ask, call, mixed - 1])
    expect(ops[0]?.shadowedSeqs).not.toContain(mixed)
  })

  it('stops widening over a result that answers nothing it is looking for', () => {
    const live = started('plan-unanswered')
    const ask = userEvent(live, 'ask')
    const call = live.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool-call', id: CallId('call-open'), name: 'read', arguments: '{}' },
        ],
        source: ROUTE,
      }),
    }, { surfaceOp: 'append' }).seq
    // A result the fold is not waiting for — another round's, whose own call sits
    // outside the span. The walk is looking for `call-open`, so this node answers
    // nothing and it stops here: a fold is a contiguous run of ground one
    // recollection owns, and a node it cannot answer is somebody else's.
    const foreign = live.append('tool/result', {
      turn: 0,
      step: 2,
      message: createToolResultMessage({
        callId: CallId('call-elsewhere'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq

    const ops = plan(live, {
      summaries: [summary('L1-0', 1)],
      ranges: new Map([['L1-0', span(ask, call)]]),
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, call])
    expect(ops[0]?.shadowedSeqs).not.toContain(foreign)
  })

  // Two recollections stand over one message: the later one is the entry the
  // level resolves to, and both of them claim the same run. Only one node can
  // replace a position, so the first op takes the ground and the second one —
  // whose run is that same ground — has nothing left to fold.
  // One recollection's claim reaches into the other's ground: the picker resolved
  // one message to each of them, while the older one's range still covers both.
  // Only the ground each op holds is folded — the shared message goes to the op
  // that resolved it, and the older one keeps what is left.
  it('folds the part of its run a sibling holds', () => {
    const live = started('plan-shadow-overlap')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    const ops = plan(live, {
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      ranges: new Map([['L1-0', span(ask, answer)], ['L1-1', span(answer, answer)]]),
    })

    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([
      ['L1-0', [ask]],
      ['L1-1', [answer]],
    ])
  })

  it('yields a run a sibling already owns', () => {
    const live = started('plan-shadow-slack')
    const ask = userEvent(live, 'ask')

    const ops = plan(live, {
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      ranges: new Map([['L1-0', span(ask, ask)], ['L1-1', span(ask, ask)]]),
    })

    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([['L1-1', [ask]]])
  })

  // The sibling boundary the widening pass has to respect from the other side:
  // the second recollection's round is its own, and the first op stops at its
  // ask rather than widening over it.
  it('stops widening where the next node belongs to a sibling fold', () => {
    const live = started('plan-shadow')
    const askA = userEvent(live, 'a')
    const a = toolRound(live, 'call-a', 1)
    const askB = userEvent(live, 'b')
    const b = toolRound(live, 'call-b', 2)
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // Each recollection resolves its own round, so the two folds are one op each
    // and neither is the other's to take.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([
        [ids[0]!, 1], [ids[1]!, 1], [ids[3]!, 1], [ids[4]!, 1],
      ]),
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      seeded: new Map([['L1-0', span(askA, a.call)], ['L1-1', span(askB, b.call)]]),
      seqOf,
    })

    // The first recollection stands over the ask alone and the second over the
    // whole round: the first op takes its own ground and its round, and the
    // second the rest — no node is folded twice.
    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([
      ['L1-0', [askA, a.call, a.result]],
      ['L1-1', [askB, b.call, b.result]],
    ])
  })

  // Two recollections can stand over one run at one level: they resolve their own
  // messages and the planner picks the standing entry from the level. Only one
  // node can replace a position, so the later op yields its whole claim rather
  // than fold part of it — a partial fold leaves the rest of that ground standing
  // behind a node claiming all of it.
  it('yields the whole claim to the op that owns it', () => {
    const live = started('plan-two-owners')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const reply = userEvent(live, 'reply')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // Two recollections of one level over adjacent ground, both resolving their
    // own messages: nothing overlaps, so both folds land, in plan order.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1], [ids[2]!, 1]]),
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      seeded: new Map([['L1-0', span(ask, answer)], ['L1-1', span(reply, reply)]]),
      seqOf,
    })

    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([
      ['L1-0', [ask, answer]],
      ['L1-1', [reply]],
    ])
  })

  // The parallel round P1 is about: one node asks for two tools, the results land
  // on two nodes after it. A recollection covering the second result is half a
  // round, and its call node is two nodes back rather than the one the old
  // one-node reach looked at.
  it('reaches the call node two nodes back for a parallel round', () => {
    const live = started('plan-parallel')
    const { call, results } = parallelRound(live, ['c1', 'c2'])
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)
    const second = results[1] as number

    // Only the second result resolves: the picker covered the tail of the round.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[2] as string, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(second, second)]]),
      seqOf,
    })

    // Both calls, both results and the node declaring them, so the landed fold
    // leaves no call visible without its tool message.
    expect(ops[0]?.shadowedSeqs).toEqual([call, results[0], second])
  })

  // A pre-rewrite fold names its recollection in the text alone — its
  // `autobio-session-*` compaction id matches no prefix — so a reader that only
  // consults the source reads the node as ground and folds it a second time.
  // A fold node belongs to the recollection it names, so taking one is the claim
  // that this recollection stands over the ground that node stands for — with it,
  // the nodes underneath, not just the node's place on the surface. Without those
  // the replacement names ground no node of the surface covers, and the session
  // refuses it.
  it('names the ground under the sibling fold node it takes', () => {
    const live = started('plan-foreign-node')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    // A recollection that landed over the ask before this planner ran.
    const landed = foldNode(live, 'L1-9', [ask])

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[mirrored(store)[0]!, 1], [mirrored(store)[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    expect(ops[0]?.shadowedSeqs).toEqual([landed.seq, answer])
    expect(ops[0]?.coveredNodes).toEqual([landed.seq, ask, answer])
  })

  it('reads a pre-rewrite fold node off the header its text leads with', () => {
    const live = started('plan-legacy')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L1-0] the ground this stands for' }],
        source: { ...ROUTE, compactionId: 'autobio-session-L1-0-3' },
      }),
    }, { surfaceOp: { op: 'replace', start: ask, end: answer }, sourceEventSeqs: [ask, answer] })

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[mirrored(store)[0]!, 1], [mirrored(store)[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    expect(ops).toEqual([])
  })

  it('expands a landed fold to the ground it replaced', () => {
    const live = started('plan-coverage')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf, known } = seeded(live)
    // A fold that landed before this planner ran, over ground the recollection
    // below still covers.
    const landed = foldNode(live, 'L1-9', [ask])
    const ops = plan(live, {
      store,
      seqOf,
      summaries: [summary('L1-0', 1)],
      ranges: new Map([...known, ['L1-0', span(ask, answer)]]),
    })

    // The landed node stands in its ground's place, so the op takes it along with
    // the message behind it. Shadows carry the surface's order, so the log seq the
    // node was written at reads out of order here.
    expect(ops[0]?.shadowedSeqs).toEqual([landed.seq, answer])
  })

  it('reads coverage from the seeded range when the entry cites nothing', () => {
    const live = started('plan-seeded-only')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')

    const ops = plan(live, {
      level: 1,
      summaries: [summary('L1-0', 1)],
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it('reads coverage from the entry sources when seeding recorded no range', () => {
    const live = started('plan-resolved-only')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    const ops = plan(live, {
      store,
      seqOf,
      summaries: [summary('L1-0', 1, { sourceIds: ids, sourceRange: { first: ids[0] as string, last: ids.at(-1) as string } })],
      ranges: new Map(),
      resolutions: new Map(ids.map(id => [id, 1])),
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it('refuses to fold ground no recollection of the resolved level stands over', () => {
    const live = started('plan-unknown')
    const ask = userEvent(live, 'ask')
    textEvent(live, 'answer')

    const { store, seqOf } = seeded(live)
    // The recollection cites nothing and seeding recorded no range, so it stands
    // over no ground even though the picker resolved one. Refusing the plan beats
    // folding the message into a recollection that does not cover it, and beats
    // dropping it silently.
    const plan = (): FoldOp[] => planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[mirrored(store)[0]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map(),
      seqOf,
    })

    expect(plan).toThrow(DivergenceError)
    expect(plan).toThrow(`no level-1 recollection stands for log seq ${ask}`)
  })

  it('takes back the half round the fold would break', () => {
    const live = started('plan-half-round')
    const first = toolRound(live, 'call-first', 1)
    const second = toolRound(live, 'call-second', 2)
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // The recollection resolves the second round alone, so the fold begins at a
    // result whose call sits one node before it — half a round, and the only
    // reason backward reach exists.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[2]!, 1], [ids[3]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(second.call, second.result)]]),
      seqOf,
    })

    expect(ops[0]?.shadowedSeqs).toEqual([second.call, second.result])
    expect(ops[0]?.shadowedSeqs).not.toContain(first.result)
  })

  it("reads a fold node's footprint through the node that replaced it", () => {
    const live = started('plan-nested')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    // A fold that supersedes an earlier one cites both the ground underneath and
    // the node that replaced it — the shape whose footprint crosses two entries.
    const lower = foldNode(live, 'L2-0', [ask, answer])
    const upper = foldNode(live, 'L3-0', [lower.seq])
    const { store, seqOf } = seeded(live)

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([]),
      summaries: [summary('L3-0', 3), summary('L2-0', 2)],
      seeded: new Map([
        ['L3-0', span(ask, answer)],
        ['L2-0', span(ask, answer)],
      ]),
      seqOf,
    })

    // The third-level recollection stands for the whole ground, so neither
    // landed node is its to replace.
    expect(ops).toEqual([])
    expect(ops.flatMap(op => op.shadowedSeqs)).not.toContain(upper.seq)
    expect(ops.flatMap(op => op.shadowedSeqs)).not.toContain(lower.seq)
  })

  it('leaves a node with no message alone', () => {
    const live = started('plan-nomessage')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    live.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    const { store, seqOf } = seeded(live)

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[mirrored(store)[0]!, 1], [mirrored(store)[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    // `turn/end` is surface-eligible but carries no message, so the fold takes
    // the ground and leaves that node standing.
    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it("leaves a recollection's own landed node out of its next fold", () => {
    const live = started('plan-own-node')
    const ask = userEvent(live, 'ask')
    foldNode(live, 'L1-0', [ask])
    const { store, seqOf } = seeded(live)

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[mirrored(store)[0]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, ask)]]),
      seqOf,
    })

    expect(ops).toEqual([])
  })

  it('takes a node the picker left out of its recollection', () => {
    const live = started('plan-no-fold-id')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    // A message inside a span a lower-level fold already took, so the planner
    // reads it as a node with no recollection of its own.
    live.append('assistant/message', {
      turn: 0,
      step: 2,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'tail' }], source: ROUTE }),
    }, { surfaceOp: 'append' })
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask, answer])
  })

  it('leaves a node it cannot place in the store out of its span', () => {
    const live = started('plan-unplaced')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)
    const rows = store.getStateJson(MESSAGES_STATE) as Array<Record<string, unknown>>
    store.setStateJson(MESSAGES_STATE, rows.map((row, index) => (index === 1 ? { ...row, metadata: {} } : row)))

    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[1]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, answer)]]),
      seqOf,
    })

    // The message is still ground by its log seq; only its place in the store is
    // unknown, so the recollection stands for the range it recorded.
    expect(ops[0]?.shadowedSeqs).toEqual([ask])
  })

  it('leaves an earlier fold the nodes it already claimed', () => {
    const live = started('plan-two-runs')
    const ask = userEvent(live, 'ask')
    const { call, result } = toolRound(live, 'call-two', 1)
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // Two recollections resolved the same transcript at the same level. Ops
    // arrive in plan order, so the first takes the message it resolved and the
    // second owns the round rather than both widening over the same nodes.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[2]!, 1], [ids[1]!, 1]]),
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      seeded: new Map([
        ['L1-0', span(ask, result)],
        ['L1-1', span(call, result)],
      ]),
      seqOf,
    })

    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([
      ['L1-0', [ask]],
      ['L1-1', [call, result]],
    ])
  })

  it('folds one recollection whose messages sit in two separate runs', () => {
    const live = started('plan-two-ids')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // The recollection stands for the first message, a later recollection took
    // the message between, and it stands for the last one too — so its ids
    // arrive as two runs that fold as one.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1], [ids[2]!, 1], [ids[1]!, 1]]),
      summaries: [summary('L1-0', 1), summary('L1-1', 1)],
      seeded: new Map([
        ['L1-0', span(ask, ask)],
        ['L1-1', span(answer, answer)],
      ]),
      seqOf,
    })

    expect(ops.map(op => [op.summaryId, op.shadowedSeqs])).toEqual([
      ['L1-0', [ask]],
      ['L1-1', [answer]],
    ])
  })

  it('leaves a fold at the head of the surface unextended', () => {
    const live = started('plan-head')
    const ask = userEvent(live, 'ask')
    const answer = textEvent(live, 'answer')
    const { store, seqOf } = seeded(live)
    const ids = mirrored(store)

    // Nothing precedes the fold's first node, so there is no half round to take
    // back and the span is the recollection's own.
    const ops = planFolds(store, live, {
      price: priceSurfaceNode,
      resolutions: new Map([[ids[0]!, 1]]),
      summaries: [summary('L1-0', 1)],
      seeded: new Map([['L1-0', span(ask, ask)]]),
      seqOf,
    })

    expect(ops[0]?.shadowedSeqs).toEqual([ask])
    expect(ops[0]?.shadowedSeqs).not.toContain(answer)
  })
})
