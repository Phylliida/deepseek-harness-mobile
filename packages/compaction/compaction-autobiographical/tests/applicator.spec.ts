import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextEntry, SourceRelation } from '@animalabs/context-manager'
import { planFolds } from '../src/applicator.ts'
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
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'probe', arguments: '{}' }],
      source: { kind: 'model', provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  seqs['r1'] = session.append('user/message', createUserMessage({
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }],
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
      // The answer's text blocks ride the recall header; reasoning is dropped.
      text: '[Recall L1-0]\n\nI remember the exchange.',
    }])
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

  it('abandons the pass when a raw selection falls outside the fold covering it', () => {
    const { session, seqs } = conversation()
    appendFold(session, 'L1-0', seqs['q1']!, seqs['a1']!)
    const plan = planFolds(
      session,
      runtime({ messages: { q2: { metadata: { dshSeq: seqs['q2'] } } } }),
      [raw(['q2'])],
    )
    expect(plan).toBeNull()
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
    ['the range starts before the fold', [1, 2], { first: 0, last: 1 }],
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

  it('refuses a fold whose called tool result does not follow', () => {
    // The span ends with the call, but the next raw node is plain text: the
    // pair cannot be made whole, so the pass plans nothing.
    const session = Session.create(SessionId('applicator-no-result'))
    const q = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const a = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'probe', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    const q2 = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q2' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const mirror = runtime({
      messages: {
        q1: { metadata: { dshSeq: q } },
        a1: { metadata: { dshSeq: a } },
        q2: { metadata: { dshSeq: q2 } },
      },
      summaries: { F: { id: 'F', level: 1, first: 'a1', last: 'a1' } },
    })
    expect(planFolds(session, mirror, [raw(['q1']), ...recall('F'), raw(['q2'])])).toBeNull()
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
        content: [{ type: 'tool-call', id: 'c1', name: 'probe', arguments: '{}' }],
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
    appendFold(session, 'G', seqs['r1'], seqs['r1'])
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
        content: [{ type: 'tool-call', id: 'c1', name: 'probe', arguments: '{}' }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    seqs['x1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'note' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    seqs['r1'] = session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }],
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
    appendFold(session, 'G', seqs['a1'], seqs['a1'])
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
