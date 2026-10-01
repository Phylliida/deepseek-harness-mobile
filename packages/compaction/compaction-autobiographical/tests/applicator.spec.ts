import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextEntry, SourceRelation } from '@animalabs/context-manager'
import { assertFoldOpsApply, planFolds } from '../src/applicator.ts'
import type { SessionRuntime } from '../src/mirror.ts'

/** One mirrored message: only the stamped seq participates in planning. */
type MirroredMessage = { readonly metadata?: Record<string, unknown> } | null

interface StubOptions {
  readonly messages?: Readonly<Record<string, MirroredMessage>>
  readonly summaries?: Readonly<Record<string, {
    readonly id: string
    readonly level: number
    readonly first: string
    readonly last: string
  } | null>>
}

/**
 * A runtime whose strategy/manager answers from tables. Planning reads exactly
 * two members — the seq stamp of a mirrored message and the summary archive —
 * so the tables are the whole collaborator surface.
 */
function runtime(options: StubOptions = {}): SessionRuntime {
  const { messages = {}, summaries = {} } = options
  return {
    watermark: 0,
    manager: {
      getMessage: (id: string) => messages[id] ?? null,
    },
    strategy: {
      getSummary: (id: string) => {
        const found = summaries[id]
        if (found === null || found === undefined) return null
        return { id: found.id, level: found.level, sourceRange: { first: found.first, last: found.last } }
      },
    },
  } as unknown as SessionRuntime
}

/** A raw selection: `sourceMessageIds`, or the single-source legacy form. */
function raw(sourceIds: readonly string[] | undefined, options: { legacyId?: string; relation?: SourceRelation } = {}): ContextEntry {
  return {
    index: 0,
    participant: 'user',
    content: [],
    sourceRelation: options.relation ?? 'copy',
    ...options.legacyId === undefined ? {} : { sourceMessageId: options.legacyId },
    ...sourceIds === undefined ? {} : { sourceMessageIds: [...sourceIds] },
  }
}

/** A recall pair: the question names nothing, the answer carries the summary id. */
function recall(cacheLayoutKey: string | undefined, text = 'I remember the exchange.'): ContextEntry[] {
  return [
    {
      index: 0,
      participant: 'Context Manager',
      content: [{ type: 'text', text: 'What do you remember from earlier?' }],
      sourceRelation: 'derived',
    },
    {
      index: 1,
      participant: 'assistant',
      content: [{ type: 'reasoning', text: 'aside' }, { type: 'text', text }],
      sourceRelation: 'derived',
      ...cacheLayoutKey === undefined ? {} : { cacheLayoutKey },
    },
  ] as unknown as ContextEntry[]
}

const SUMMARY = { id: 'L1-0', level: 1, first: 'q1', last: 'a1' }

/** The applicator's message price: ceil over text characters. */
const tok = (text: string): number => Math.ceil(text.length / 4)

/** A session whose raw turns are the mirrored ids `q1`/`a1` (and `q2`). */
function conversation(): { session: Session; seqs: Record<string, number> } {
  const session = Session.create(SessionId('applicator'))
  const seqs: Record<string, number> = {}
  seqs['q1'] = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'q1' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  seqs['a1'] = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'a1' }],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  seqs['q2'] = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'q2' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  return { session, seqs }
}

/** Append this backend's own fold node over an existing surface range. */
function appendFold(session: Session, summaryId: string, start: number, end: number): number {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `[Recall ${summaryId}]\n\nI recall it.` }],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    }),
  }, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: session.surface.nodes.filter(seq => seq >= start && seq <= end),
  }).seq
}

/** A hand-built session: the synthetic topologies a live log cannot reach. */
function stubSession(events: readonly SessionEvent[], nodes: readonly number[]): Session {
  return { events, surface: { nodes } } as unknown as Session
}

/** A hand-built fold node covering exactly `sources`. */
function stubFold(seq: number, summaryId: string, sources: readonly number[]): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m-${seq}`,
        role: 'assistant',
        content: [{ type: 'text', text: `[Recall ${summaryId}]\n\nI recall it.` }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
    surfaceOp: { op: 'replace', start: sources[0] ?? seq, end: sources.at(-1) ?? seq },
    sourceEventSeqs: [...sources],
  } as unknown as SessionEvent
}


/** A raw turn with a tool call (`a1`) answered by `r1`, then plain text. */
function toolConversation(): { session: Session; seqs: Record<string, number> } {
  const session = Session.create(SessionId('applicator-tools'))
  const seqs: Record<string, number> = {}
  seqs['q1'] = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'q1' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  seqs['a1'] = session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: CallId('c1'), name: 'probe', arguments: '{}' }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  seqs['r1'] = session.append('user/message', createUserMessage({
    content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'done' }] }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  seqs['q2'] = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'q2' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  return { session, seqs }
}

/** A mirror/runtime table for the tool conversation's message ids. */
function toolRuntime(seqs: Record<string, number>, summaries: StubOptions['summaries'] = {}): SessionRuntime {
  return runtime({
    messages: Object.fromEntries(Object.entries(seqs).map(([id, seq]) => [id, { metadata: { dshSeq: seq } }])),
    summaries,
  })
}

/** A plain text node on the surface. */
function appendPlain(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** An assistant node declaring the given tool calls. */
function appendCalls(session: Session, ...ids: string[]): number {
  return session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: ids.map(id => ({ type: 'tool-call' as const, id: CallId(id), name: 'probe', arguments: '{}' })),
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
}

/** A tool node answering the given calls (and optionally declaring new ones). */
function appendResults(session: Session, ids: readonly string[], calls: readonly string[] = []): number {
  return session.append('user/message', createUserMessage({
    content: [
      ...ids.map(id => ({ type: 'tool-result' as const, toolCallId: CallId(id), content: [{ type: 'text' as const, text: 'done' }] })),
      ...calls.map(id => ({ type: 'tool-call' as const, id: CallId(id), name: 'probe', arguments: '{}' })),
    ],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** A runtime stub: seqs as m0..mN, plus one summary over seqs[first]..seqs[last]. */
function rt(seqs: readonly number[], summaryId: string, first: number, last: number): SessionRuntime {
  return runtime({
    messages: Object.fromEntries(seqs.map((seq, i) => [`m${i}`, { metadata: { dshSeq: seq } }])),
    summaries: { [summaryId]: { id: summaryId, level: 1, first: `m${first}`, last: `m${last}` } },
  })
}

describe('assertFoldOpsApply', () => {
  it('accepts ops that cite every surface node in their range', () => {
    expect(() => {
      assertFoldOpsApply([0, 1, 2], [{
        summaryId: 'L1-0',
        level: 1,
        startSeq: 0,
        endSeq: 1,
        shadowedSeqs: [0, 1],
        shadowedTokens: 2,
        text: '[Recall L1-0]',
      }])
    }).not.toThrow()
  })

  it('checks the range positionally — a fold node\'s late seq is not swept in', () => {
    // Surface order is positional; fold nodes carry replacement-message seqs
    // that can numerically fall inside a later op's range while sitting
    // before it (production shape from the b410187f stall).
    expect(() => {
      assertFoldOpsApply([1, 3, 2, 4, 5], [{
        summaryId: 'L1-0',
        level: 1,
        startSeq: 2,
        endSeq: 5,
        shadowedSeqs: [2, 4, 5],
        shadowedTokens: 3,
        text: '[Recall L1-0]',
      }])
    }).not.toThrow()
  })

  it('throws when an op\'s range does not resolve on the surface', () => {
    expect(() => {
      assertFoldOpsApply([0, 1, 2], [{
        summaryId: 'L1-0',
        level: 1,
        startSeq: 7,
        endSeq: 9,
        shadowedSeqs: [7, 9],
        shadowedTokens: 2,
        text: '[Recall L1-0]',
      }])
    }).toThrow('fold L1-0 range 7..9 does not resolve on the live surface')
  })

  it('throws before the bracket opens when an op skips a surface node', () => {
    expect(() => {
      assertFoldOpsApply([0, 1, 2], [{
        summaryId: 'L1-0',
        level: 1,
        startSeq: 0,
        endSeq: 2,
        shadowedSeqs: [0, 2],
        shadowedTokens: 2,
        text: '[Recall L1-0]',
      }])
    }).toThrow('fold L1-0 would shadow seqs 1 without citing them')
  })
})

describe('planFolds', () => {
  it('returns no ops when the surface already matches the selected layout', () => {
    const { session } = conversation()
    const plan = planFolds(
      session,
      runtime({ messages: { q1: { metadata: { dshSeq: 0 } }, a1: { metadata: { dshSeq: 1 } } } }),
      [raw(['q1']), raw(['a1'])],
    )
    expect(plan).toEqual([])
  })

  it('accepts the single-source form and a multi-message composite', () => {
    const { session, seqs } = conversation()
    const mirror = runtime({
      messages: {
        q1: { metadata: { dshSeq: seqs['q1'] } },
        a1: { metadata: { dshSeq: seqs['a1'] } },
        q2: { metadata: { dshSeq: seqs['q2'] } },
      },
    })
    // A legacy single `sourceMessageId` resolves the same seq as the list form,
    // and a composite entry names every message it stands for.
    expect(planFolds(session, mirror, [raw(undefined, { legacyId: 'q1' })])).toEqual([])
    expect(planFolds(session, mirror, [raw(['q1', 'a1', 'q2'])])).toEqual([])
  })

  it('ignores entries it does not reconcile', () => {
    const { session } = conversation()
    expect(planFolds(session, runtime(), [raw(['q1'], { relation: 'referenced' })])).toEqual([])
  })

  it.each([
    ['a copy that names no source message', [raw([])]],
    ['a copy naming an empty source list', [raw(undefined)]],
    ['a copy naming a message the mirror never saw', [raw(['ghost'])]],
    ['a derived entry with no answer following it', recall(undefined).slice(0, 1)],
    ['a recall answer carrying no summary id', recall(undefined)],
  ])('abandons the pass on %s', (_label, entries) => {
    const { session } = conversation()
    expect(planFolds(session, runtime(), entries)).toBeNull()
  })

  it('abandons the pass when the summary archive cannot resolve a recollection', () => {
    const { session, seqs } = conversation()
    const mirror = runtime({
      messages: { q1: { metadata: { dshSeq: seqs['q1'] } }, a1: { metadata: { dshSeq: seqs['a1'] } } },
      summaries: { 'L1-0': SUMMARY },
    })

    // Unknown summary id, and a summary whose covered range is not mirrored.
    expect(planFolds(session, mirror, recall('L1-9'))).toBeNull()
    expect(planFolds(session, runtime({
      messages: { q1: { metadata: { dshSeq: seqs['q1'] } } },
      summaries: { 'L1-0': { ...SUMMARY, last: 'ghost' } },
    }), recall('L1-0'))).toBeNull()
    // An inverted range (last before first) is not a range this surface can hold.
    expect(planFolds(session, runtime({
      messages: {
        q1: { metadata: { dshSeq: seqs['q2'] } },
        a1: { metadata: { dshSeq: seqs['q1'] } },
      },
      summaries: { 'L1-0': SUMMARY },
    }), recall('L1-0'))).toBeNull()
  })

  it('plans one recollection node over the raw span it covers', () => {
    const { session, seqs } = conversation()
    const plan = planFolds(
      session,
      runtime({
        messages: {
          q1: { metadata: { dshSeq: seqs['q1'] } },
          a1: { metadata: { dshSeq: seqs['a1'] } },
          q2: { metadata: { dshSeq: seqs['q2'] } },
        },
        summaries: { 'L1-0': SUMMARY },
      }),
      [...recall('L1-0'), raw(['q2'])],
    )
    expect(plan).toEqual([{
      summaryId: 'L1-0',
      level: 1,
      startSeq: seqs['q1'],
      endSeq: seqs['a1'],
      shadowedSeqs: [seqs['q1'], seqs['a1']],
      shadowedTokens: tok('q1') + tok('a1'),
      // The answer's text blocks ride the recall header; reasoning is dropped.
      text: '[Recall L1-0]\n\nI remember the exchange.',
    }])
  })

  it('refuses when a pending call\'s result is raw beyond a fold node', () => {
    const session = Session.create(SessionId('applicator-f1'))
    const a = appendCalls(session, 'c1')
    const x = appendPlain(session, 'x1')
    const r = appendResults(session, ['c1'])
    appendFold(session, 'L1-x', x, x)
    // The picker wants [a] folded; its result sits raw past the fold node.
    expect(planFolds(session, rt([a, r], 'L1-0', 0, 0), recall('L1-0'))).toBeNull()
  })

  it('folds when a pending call\'s result is nowhere visible', () => {
    const session = Session.create(SessionId('applicator-f1b'))
    const a = appendCalls(session, 'c1')
    const x = appendPlain(session, 'x1')
    appendFold(session, 'L1-x', x, x)
    const plan = planFolds(session, rt([a], 'L1-0', 0, 0), recall('L1-0'))
    expect(plan?.map(op => op.shadowedSeqs)).toEqual([[a]])
  })

  it('scans past multiple fold nodes for a pending call\'s result', () => {
    const session = Session.create(SessionId('applicator-f1c'))
    const a = appendCalls(session, 'c1')
    const x1 = appendPlain(session, 'x1')
    const x2 = appendPlain(session, 'x2')
    const r = appendResults(session, ['c1'])
    appendFold(session, 'L1-x1', x1, x1)
    appendFold(session, 'L1-x2', x2, x2)
    expect(planFolds(session, rt([a, r], 'L1-0', 0, 0), recall('L1-0'))).toBeNull()
  })

  it('refuses when the span\'s first result has its call raw before a fold node', () => {
    const session = Session.create(SessionId('applicator-f2'))
    const q = appendPlain(session, 'q1')
    const a = appendCalls(session, 'c1')
    const x = appendPlain(session, 'x1')
    const r = appendResults(session, ['c1'])
    appendFold(session, 'L1-x', x, x)
    const mirror = rt([q, a, r], 'L1-0', 2, 2)
    expect(planFolds(session, mirror, [raw(['m0']), raw(['m1']), ...recall('L1-0')])).toBeNull()
  })

  it('folds when that call is already shadowed inside the fold node', () => {
    const session = Session.create(SessionId('applicator-f2b'))
    const q = appendPlain(session, 'q1')
    const a = appendCalls(session, 'c1')
    const x = appendPlain(session, 'x1')
    const r = appendResults(session, ['c1'])
    appendFold(session, 'L1-x', a, x)
    const mirror = rt([q, r], 'L1-0', 1, 1)
    const plan = planFolds(session, mirror, [raw(['m0']), ...recall('L1-0')])
    expect(plan?.map(op => op.shadowedSeqs)).toEqual([[r]])
  })

  it('refuses a fold-around whose result\'s call is raw before the skipped node', () => {
    const session = Session.create(SessionId('applicator-f3'))
    const a = appendCalls(session, 'c1')
    const x1 = appendPlain(session, 'x1')
    const x2 = appendPlain(session, 'x2')
    const r = appendResults(session, ['c1'])
    appendFold(session, 'L1-x', x1, x2)
    // The range starts inside the fold node and extends past it: fold-around
    // skips the node, then backward repair must refuse — the result's call is
    // raw upstream, and pulling it in would skip the fold node mid-span.
    const mirror = runtime({
      messages: {
        ma: { metadata: { dshSeq: a } },
        mx2: { metadata: { dshSeq: x2 } },
        mr: { metadata: { dshSeq: r } },
      },
      summaries: { 'L1-0': { id: 'L1-0', level: 1, first: 'mx2', last: 'mr' } },
    })
    expect(planFolds(session, mirror, [raw(['ma']), ...recall('L1-0')])).toBeNull()
  })

  it('chains backward pair repair until the call set closes', () => {
    const session = Session.create(SessionId('applicator-f5'))
    const a0 = appendCalls(session, 'c0')
    const m1 = appendResults(session, ['c0'], ['c1'])
    const r2 = appendResults(session, ['c1'])
    // Folding [r2] pulls in m1 (c1's declaration), whose own result c0 then
    // pulls in a0: the whole chain shadows together or not at all.
    const mirror = rt([a0, m1, r2], 'L1-0', 2, 2)
    const plan = planFolds(session, mirror, [raw(['m0']), raw(['m1']), ...recall('L1-0')])
    expect(plan?.map(op => op.shadowedSeqs)).toEqual([[a0, m1, r2]])
  })

  it('refuses when the backward chain meets an unrelated raw node', () => {
    const session = Session.create(SessionId('applicator-f5b'))
    const a0 = appendCalls(session, 'c0')
    const x = appendPlain(session, 'x')
    const m1 = appendResults(session, ['c0'], ['c1'])
    const r2 = appendResults(session, ['c1'])
    const mirror = rt([a0, x, m1, r2], 'L1-0', 3, 3)
    expect(planFolds(session, mirror, [raw(['m0']), raw(['m1']), raw(['m2']), ...recall('L1-0')])).toBeNull()
  })

  it('folds a result whose call never reached the surface', () => {
    const session = Session.create(SessionId('applicator-orphan-result'))
    const r = appendResults(session, ['c9'])
    const plan = planFolds(session, rt([r], 'L1-0', 0, 0), recall('L1-0'))
    expect(plan?.map(op => op.shadowedSeqs)).toEqual([[r]])
  })

  it('refuses when the next raw result answers a call outside the span', () => {
    const session = Session.create(SessionId('applicator-interleaved'))
    const a0 = appendCalls(session, 'c0')
    const a1 = appendCalls(session, 'c1')
    appendResults(session, ['c0'])
    appendResults(session, ['c1'])
    // Folding [a1] would need to absorb r0 first — but r0 answers c0, which
    // the fold leaves visible; absorbing it orphans c0, so the pass refuses.
    const mirror = rt([a0, a1], 'L1-0', 1, 1)
    expect(planFolds(session, mirror, [raw(['m0']), ...recall('L1-0')])).toBeNull()
  })

  it('leaves an already-applied recollection in place', () => {
    const { session, seqs } = conversation()
    appendFold(session, 'L1-0', seqs['q1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      runtime({
        messages: { q1: { metadata: { dshSeq: seqs['q1'] } }, a1: { metadata: { dshSeq: seqs['a1'] } } },
        summaries: { 'L1-0': SUMMARY },
      }),
      recall('L1-0'),
    )
    expect(plan).toEqual([])
  })

  it('refines a single coarser node into the finer recollection', () => {
    const { session, seqs } = conversation()
    const foldSeq = appendFold(session, 'L2-1', seqs['q1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      runtime({
        messages: { q1: { metadata: { dshSeq: seqs['q1'] } }, a1: { metadata: { dshSeq: seqs['a1'] } } },
        summaries: { 'L1-0': SUMMARY },
      }),
      recall('L1-0'),
    )
    expect(plan).toEqual([{
      summaryId: 'L1-0',
      level: 1,
      startSeq: foldSeq,
      endSeq: foldSeq,
      shadowedSeqs: [foldSeq],
      shadowedTokens: tok('[Recall L2-1]\n\nI recall it.'),
      text: '[Recall L1-0]\n\nI remember the exchange.',
    }])
    // Planning is pure: nothing landed, so the same refinement is still planned.
    expect(planFolds(
      session,
      runtime({
        messages: { q1: { metadata: { dshSeq: seqs['q1'] } }, a1: { metadata: { dshSeq: seqs['a1'] } } },
        summaries: { 'L1-0': SUMMARY },
      }),
      recall('L1-0'),
    )).toEqual(plan)
  })

  it('keeps a raw selection the surface already folded at a coarser level', () => {
    const { session, seqs } = conversation()
    appendFold(session, 'L1-0', seqs['q1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      runtime({ messages: { q1: { metadata: { dshSeq: seqs['q1'] } } } }),
      [raw(['q1'])],
    )
    expect(plan).toEqual([])
  })

  it('leaves a coarser fold whose coverage the layout has moved past', () => {
    // The layout names only q2; the L1-0 fold ahead is stale-coarser
    // leftover, so the walk leaves it and matches q2 without ops.
    const { session, seqs } = conversation()
    appendFold(session, 'L1-0', seqs['q1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      runtime({ messages: { q2: { metadata: { dshSeq: seqs['q2'] } } } }),
      [raw(['q2'])],
    )
    expect(plan).toEqual([])
  })

  it('abandons the pass when the selection is longer than the surface', () => {
    const session = Session.create(SessionId('applicator-short'))
    const q1 = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const a1 = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: {
        q1: { metadata: { dshSeq: q1 } },
        a1: { metadata: { dshSeq: a1 } },
        q2: { metadata: { dshSeq: 99 } },
      },
    })
    // Three selected messages over a two-node surface: the layout cannot align.
    expect(planFolds(session, mirror, [raw(['q1']), raw(['a1']), raw(['q2'])])).toBeNull()
  })

  it('clamps a finer range the surface already holds inside a coarser node', () => {
    // A coarser recollection covering the whole conversation: the range asked
    // for sits strictly inside it, which one replace node cannot express.
    const fold = stubFold(7, 'L2-0', [1, 2, 3])
    const plan = planFolds(
      stubSession([fold], [7]),
      runtime({
        messages: { q1: { metadata: { dshSeq: 1 } }, a1: { metadata: { dshSeq: 2 } } },
        summaries: { 'L1-0': SUMMARY },
      }),
      recall('L1-0'),
    )
    expect(plan).toEqual([])
  })

  it.each([
    ['the range does not intersect the fold', [10, 20], { first: 0, last: 1 }],
    ['the range ends past the fold coverage', [1], { first: 2, last: 3 }],
    ['the node ahead is not a fold at all', null, { first: 1, last: 2 }],
  ] as Array<[string, readonly number[] | null, { first: number; last: number }]>)(
    'abandons the pass when %s',
    (_label, covers, range) => {
      const events = covers === null ? [] : [stubFold(7, 'L1-0', covers)]
      const plan = planFolds(
        stubSession(events, [7]),
        runtime({
          messages: { first: { metadata: { dshSeq: range.first } }, last: { metadata: { dshSeq: range.last } } },
          summaries: { 'L1-0': { id: 'L1-0', level: 1, first: 'first', last: 'last' } },
        }),
        recall('L1-0'),
      )
      expect(plan).toBeNull()
    },
  )

  it('measures a fold and a raw node through their full coverage', () => {
    // Two fold nodes sharing a cited source exercise the coverage memo, and a
    // replacement whose coverage points back at itself exercises the cycle guard.
    const inner = stubFold(5, 'L1-1', [1])
    const outer = stubFold(6, 'L1-2', [5])
    const plan = planFolds(
      stubSession([inner, outer], [5, 6]),
      runtime({ messages: { known: { metadata: { dshSeq: 1 } } } }),
      [raw(['known'])],
    )
    // The leading node's coverage is [1]; the raw selection it covers is kept.
    expect(plan).toEqual([])

    const self = stubFold(9, 'L1-3', [9])
    expect(planFolds(
      stubSession([self], [9]),
      runtime({ messages: { known: { metadata: { dshSeq: 1 } } } }),
      [raw(['known'])],
    )).toBeNull()
  })

  it('treats an assistant replacement without a recall header as an ordinary node', () => {
    const plain = {
      type: 'assistant/message',
      seq: 4,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm-4',
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'no text block at all' }],
          source: { kind: 'model', provider: 'test', model: 'test-model' },
        },
      },
      surfaceOp: { op: 'replace', start: 0, end: 1 },
      sourceEventSeqs: [0, 1],
    } as unknown as SessionEvent
    const plan = planFolds(
      stubSession([plain], [4]),
      runtime({ messages: { q1: { metadata: { dshSeq: 0 } } } }),
      [raw(['q1'])],
    )
    // No fold id, no seq match: the node cannot host the selection.
    expect(plan).toBeNull()
  })

  it('treats a fold node whose text does not open with the header as ordinary', () => {
    const fold = stubFold(5, 'L1-0', [1, 2])
    const headerless = {
      ...fold,
      data: {
        ...fold.data,
        message: {
          ...(fold.data as unknown as { message: Record<string, unknown> }).message,
          content: [{ type: 'text', text: 'a recollection without its header' }],
        },
      },
    } as unknown as SessionEvent
    expect(planFolds(stubSession([headerless], [5]), runtime(), [raw(['anything'])])).toBeNull()
  })

  it('keeps a coarser surface fold when the layout resolves finer', () => {
    // The surface carries L3-42 over q1..q2, but the picker now wants raw
    // copies and a finer L2 fold inside that coverage (budget growth, or a
    // deepened pyramid). The fold only shrinks the context below plan, so
    // the finer entries stand down instead of stalling the pass.
    const { session, seqs } = conversation()
    appendFold(session, 'L3-42', seqs['q1']!, seqs['q2']!)
    const mirror = runtime({
      messages: {
        q1: { metadata: { dshSeq: seqs['q1'] } },
        a1: { metadata: { dshSeq: seqs['a1'] } },
        q2: { metadata: { dshSeq: seqs['q2'] } },
      },
      summaries: { 'L2-109': { id: 'L2-109', level: 2, first: 'a1', last: 'a1' } },
    })
    expect(planFolds(
      session,
      mirror,
      [raw(['q1']), ...recall('L2-109'), raw(['q2'])],
    )).toEqual([])
  })

  it('folds around a coarser node when the range starts inside it', () => {
    // L2-109 [q2..q3] starts inside L3-42's coverage [q1..q2] and ends past
    // it: the node keeps the head (its fold already covers q2), and the new
    // fold shadows from q3 on — a replace op spans a contiguous surface
    // range, so the fold starts after the node rather than swallowing it.
    const session = Session.create(SessionId('applicator-straddle'))
    const seqs: Record<string, number> = {}
    for (const id of ['q1', 'q2', 'q3']) {
      seqs[id] = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: id }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' }).seq
    }
    appendFold(session, 'L3-42', seqs['q1']!, seqs['q2']!)
    const mirror = runtime({
      messages: Object.fromEntries(Object.entries(seqs).map(([id, seq]) => [id, { metadata: { dshSeq: seq } }])),
      summaries: { 'L2-109': { id: 'L2-109', level: 2, first: 'q2', last: 'q3' } },
    })
    const plan = planFolds(session, mirror, recall('L2-109'))
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'L2-109',
      shadowedSeqs: [seqs['q3']],
    })])
  })


  it('keeps a coarser surface fold when a finer range ends inside it', () => {
    // End-edge straddle with nothing foldable before the node: the entry
    // stands down rather than subdividing the existing fold.
    const plan = planFolds(
      stubSession([stubFold(7, 'L1-0', [10, 20])], [7]),
      runtime({
        messages: { first: { metadata: { dshSeq: 5 } }, last: { metadata: { dshSeq: 15 } } },
        summaries: { 'L2-5': { id: 'L2-5', level: 2, first: 'first', last: 'last' } },
      }),
      recall('L2-5'),
    )
    expect(plan).toEqual([])
  })

  it('abandons the pass when a fold range misses the surface entirely', () => {
    // The fold node ahead covers [100, 200]; the entry's range [1..2]
    // neither intersects nor lies past it — a genuine planner/surface
    // divergence, not a coarser surface.
    const plan = planFolds(
      stubSession([stubFold(7, 'L1-0', [100, 200])], [7]),
      runtime({
        messages: { first: { metadata: { dshSeq: 1 } }, last: { metadata: { dshSeq: 2 } } },
        summaries: { 'L1-0': { id: 'L1-0', level: 1, first: 'first', last: 'last' } },
      }),
      recall('L1-0'),
    )
    expect(plan).toBeNull()
  })

  it('widens a fold past the tool result its last node calls', () => {
    // The span [a1] ends with the call; its result r1 sits raw immediately
    // after. Folding only a1 would orphan r1 — every later request 400s — so
    // the plan absorbs r1 into the fold and its raw entry stands down.
    const { session, seqs } = toolConversation()
    const plan = planFolds(
      session,
      toolRuntime(seqs, { F: { id: 'F', level: 1, first: 'a1', last: 'a1' } }),
      [raw(['q1']), ...recall('F'), raw(['r1']), raw(['q2'])],
    )
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      startSeq: seqs['a1'],
      endSeq: seqs['r1'],
      shadowedSeqs: [seqs['a1'], seqs['r1']],
    })])
  })

  it('absorbs a pair-free splice between a call and its pending result', () => {
    // The span ends with the call and the next raw node is plain text: the
    // splice carries no pair halves, so shadowing it with the span is safe —
    // the call's result simply never arrives, which orphans nothing.
    const session = Session.create(SessionId('applicator-splice'))
    const q = appendPlain(session, 'q1')
    const a = appendCalls(session, 'c1')
    const q2 = appendPlain(session, 'q2')
    const plan = planFolds(session, rt([q, a, q2], 'L1-0', 0, 1), recall('L1-0'))
    expect(plan?.map(op => op.shadowedSeqs)).toEqual([[q, a, q2]])
  })

  it('accepts a fold whose call ends the surface', () => {
    // The span ends the surface: the result is absent (an in-flight call
    // lives in the pinned tail in practice), so nothing orphans.
    const session = Session.create(SessionId('applicator-inflight'))
    const q = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const a = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c1'), name: 'probe', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: { q1: { metadata: { dshSeq: q } }, a1: { metadata: { dshSeq: a } } },
      summaries: { F: { id: 'F', level: 1, first: 'a1', last: 'a1' } },
    })
    expect(planFolds(session, mirror, [raw(['q1']), ...recall('F')])).toEqual([
      expect.objectContaining({ summaryId: 'F', shadowedSeqs: [a] }),
    ])
  })

  it('accepts a fold whose called result is already folded away', () => {
    // r1 is folded into an existing node; a new fold over a1 leaves no
    // visible orphan behind.
    const { session, seqs } = toolConversation()
    appendFold(session, 'G', seqs['r1']!, seqs['r1']!)
    const plan = planFolds(
      session,
      toolRuntime(seqs, { F: { id: 'F', level: 1, first: 'a1', last: 'a1' }, G: { id: 'G', level: 1, first: 'r1', last: 'r1' } }),
      [raw(['q1']), ...recall('F'), ...recall('G'), raw(['q2'])],
    )
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      startSeq: seqs['a1'],
      endSeq: seqs['a1'],
      shadowedSeqs: [seqs['a1']],
    })])
  })


  it('widens a fold across every result of a parallel call fan-out', () => {
    // One assistant message calls three tools; each result rides its own
    // message. The absorb loop must close the whole pending set, not stop
    // after the first answer (the live 0aad8a1f orphan).
    const session = Session.create(SessionId('applicator-fanout'))
    const seqs: Record<string, number> = {}
    seqs['q1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    seqs['a1'] = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: ['c1', 'c2', 'c3'].map(id => ({ type: 'tool-call', id: CallId(id), name: 'probe', arguments: '{}' })),
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    for (const id of ['c1', 'c2', 'c3']) {
      seqs[id] = session.append('user/message', createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId(id), content: [{ type: 'text', text: 'done' }] }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' }).seq
    }
    seqs['q2'] = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q2' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: Object.fromEntries(Object.entries(seqs).map(([id, seq]) => [id, { metadata: { dshSeq: seq } }])),
      summaries: { F: { id: 'F', level: 1, first: 'a1', last: 'a1' } },
    })
    const plan = planFolds(session, mirror, [raw(['q1']), ...recall('F'), raw(['c1']), raw(['c2']), raw(['c3']), raw(['q2'])])
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      startSeq: seqs['a1'],
      endSeq: seqs['c3'],
      shadowedSeqs: [seqs['a1'], seqs['c1'], seqs['c2'], seqs['c3']],
    })])
  })


  it('keeps absorbing when an absorbed node declares a fresh call', () => {
    // A mixed node answers c1 and declares c4: absorbing it must extend the
    // pending set, not close early.
    const session = Session.create(SessionId('applicator-mixed'))
    const seqs: Record<string, number> = {}
    seqs['a1'] = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: CallId('c1'), name: 'probe', arguments: '{}' }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    seqs['r1'] = session.append('user/message', createUserMessage({
      content: [
        { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'done' }] },
        { type: 'tool-call', id: CallId('c4'), name: 'probe', arguments: '{}' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    seqs['r4'] = session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', toolCallId: CallId('c4'), content: [{ type: 'text', text: 'done' }] }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: Object.fromEntries(Object.entries(seqs).map(([id, seq]) => [id, { metadata: { dshSeq: seq } }])),
      summaries: { F: { id: 'F', level: 1, first: 'a1', last: 'a1' } },
    })
    const plan = planFolds(session, mirror, [...recall('F'), raw(['r1']), raw(['r4'])])
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      shadowedSeqs: [seqs['a1'], seqs['r1'], seqs['r4']],
    })])
  })

  it('widens a fold back over the raw call its first node answers', () => {
    // The span starts with r1, whose call sits raw immediately before it:
    // shadowing r1 alone would dangle the call, so the plan pulls a1 in.
    const { session, seqs } = toolConversation()
    const plan = planFolds(
      session,
      toolRuntime(seqs, { F: { id: 'F', level: 1, first: 'r1', last: 'q2' } }),
      [raw(['q1']), raw(['a1']), ...recall('F')],
    )
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      startSeq: seqs['a1'],
      endSeq: seqs['q2'],
      shadowedSeqs: [seqs['a1'], seqs['r1'], seqs['q2']],
    })])
  })

  it('refuses a fold whose result answers no adjacent call', () => {
    // r1's call is not the raw node right before the span — a text note sits
    // between them — so the adjacency invariant does not hold and the pass
    // plans nothing.
    const session = Session.create(SessionId('applicator-nonadjacent'))
    const seqs: Record<string, number> = {}
    seqs['q1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    seqs['a1'] = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('c1'), name: 'probe', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    seqs['x1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'note' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    seqs['r1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'done' }] }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: Object.fromEntries(Object.entries(seqs).map(([id, seq]) => [id, { metadata: { dshSeq: seq } }])),
      summaries: { F: { id: 'F', level: 1, first: 'r1', last: 'r1' } },
    })
    expect(planFolds(
      session,
      mirror,
      [raw(['q1']), raw(['a1']), raw(['x1']), ...recall('F')],
    )).toBeNull()
  })

  it('folds a result whose call is already folded away', () => {
    // The call is inside the existing fold G, so shadowing r1 leaves no
    // visible half behind.
    const { session, seqs } = toolConversation()
    appendFold(session, 'G', seqs['a1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      toolRuntime(seqs, { F: { id: 'F', level: 1, first: 'r1', last: 'r1' }, G: { id: 'G', level: 1, first: 'a1', last: 'a1' } }),
      [raw(['q1']), ...recall('G'), ...recall('F'), raw(['q2'])],
    )
    expect(plan).toEqual([expect.objectContaining({
      summaryId: 'F',
      startSeq: seqs['r1'],
      endSeq: seqs['r1'],
      shadowedSeqs: [seqs['r1']],
    })])
  })

})
