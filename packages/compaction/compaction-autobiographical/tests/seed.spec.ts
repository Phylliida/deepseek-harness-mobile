/**
 * Log replay: the half of the archive that is not the schema.
 *
 * Every case here is about what a *restart* does with a log someone else wrote,
 * so the fixtures build sessions by hand and assert on the store seeding leaves
 * behind. The engine specs prove folding works; these prove that folding
 * survives the process that produced it going away.
 */

import type { SummaryEntry } from '@animalabs/context-manager'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { appendSurfaceNode, readMemoryLog, seedFromLog } from '../src/seed.ts'
import { LogStore, MESSAGES_STATE, slots } from '../src/store.ts'
import type { AutobiographicalMemoryEventData, AutobiographicalMemoryMint } from '../src/types.ts'


/** A fresh session with one exchange appended, and the seqs it landed on. */
function session(id: string): { session: Session; ask: number; answer: number } {
  const live = Session.create(SessionId(id))
  live.append('turn/start', { turn: 0 })
  const ask = live.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ask' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  const answer = live.append('assistant/message', {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  live.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  return { session: live, ask, answer }
}

/** One memory-formation tick as `appendMemory` writes it. */
function tick(overrides: {
  id: string
  level?: number
  range?: { firstSeq: number; lastSeq: number }
}): AutobiographicalMemoryEventData {
  const level = overrides.level ?? 1
  return {
    chunksTotal: 1,
    chunksCompressed: 0,
    compressionCount: 0,
    l1: level,
    l2: 0,
    l3: 0,
    pendingMerges: 0,
    attempt: 1,
    memory: {
      id: overrides.id,
      level,
      content: `content of ${overrides.id}`,
      tokens: 12,
      created: 1_700_000_000_000,
      ...overrides.range === undefined ? {} : { sourceRange: overrides.range },
    },
  }
}

/** The summaries seeding wrote, as the library reads them back. */
function seededSummaries(store: LogStore): SummaryEntry[] {
  return store.getStateJson(slots().summaries.id) as SummaryEntry[]
}

/** A fold node for a recollection minted before the log recorded ranges. */
function foldNode(live: Session, id: string, ground: readonly number[], turn = 0): number {
  live.append('autobio/memory', tick({ id }))
  return live.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `[Recall ${id}] ground` }],
      source: { provider: 'test', model: 'test-model', compactionId: `autobio-session-legacy-${id}` },
    }),
  }, {
    surfaceOp: { op: 'replace', start: ground.at(0) as number, end: ground.at(-1) as number },
    sourceEventSeqs: [...ground],
  }).seq
}

describe('seedFromLog', () => {
  it('registers every slot the strategy will address', () => {
    const store = new LogStore()
    const { session: live } = session('seed-registers')
    seedFromLog(store, live)

    expect(store.listStates()).toEqual([
      { id: 'messages', strategy: 'append_log' },
      { id: 'default/autobio:summaries', strategy: 'append_log' },
      { id: 'default/autobio:counter', strategy: 'snapshot' },
    ])
  })

  it('replays append events in seq order and stamps each with its log seq', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-order')

    const { seqOf, known } = seedFromLog(store, live)

    const messages = store.getStateJson(MESSAGES_STATE) as Record<string, unknown>[]
    expect(messages.map(message => message.participant)).toEqual(['user', 'assistant'])
    expect(messages.map(message => (message.metadata as { dshSeq: number }).dshSeq)).toEqual([ask, answer])
    // The index is what a recollection minted live is later resolved through.
    expect([...seqOf.values()]).toEqual([ask, answer])
    expect([...seqOf.keys()]).toEqual(messages.map(message => message.id))
    expect(known.size).toBe(0)
  })

  it('cites a leaf\'s message ids as its sources and range', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-leaf')
    live.append('autobio/memory', tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }))

    seedFromLog(store, live)

    const [summary] = seededSummaries(store)
    expect(summary).toMatchObject({ id: 'L1-0', level: 1, sourceLevel: 0 })
    // Ids, not seqs: `SummaryEntry.sourceIds` is declared as original message ids,
    // and the range has to bound them for `recallCurveLeafIds` to see a leaf.
    const ids = summary?.sourceIds as string[]
    expect(ids).toHaveLength(2)
    expect(summary?.sourceRange).toEqual({ first: ids[0], last: ids[1] })
    expect(ids.every(id => [...(store.getStateJson(MESSAGES_STATE) as { id: string }[])].some(message => message.id === id))).toBe(true)
  })

  it('cites child recollections as the sources of a summary above them', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-parent')
    // Two children with a fold node each, because that is what membership is read
    // from: a mint alone records the ground it stood for, never where it landed, and
    // a parent finds its children by the nodes those children landed on.
    const first = foldNode(live, 'L1-0', [ask, answer])
    // A second exchange, because the first one's nodes are no longer on the surface
    // for a later fold to name.
    const later = live.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'later' }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    const second = foldNode(live, 'L1-1', [later], 1)
    // The parent's own interval, spanning both nodes, in the order the log holds them.
    live.append('autobio/memory', tick({ id: 'L2-0', level: 2, range: { firstSeq: first, lastSeq: second } }))

    seedFromLog(store, live)

    const byId = new Map(seededSummaries(store).map(summary => [summary.id, summary]))
    expect(byId.get('L2-0')?.sourceIds).toEqual(['L1-0', 'L1-1'])
    expect(byId.get('L2-0')?.sourceLevel).toBe(1)
    expect(byId.get('L2-0')?.sourceRange).toEqual({ first: 'L1-0', last: 'L1-1' })
  })

  it('drops a recollection whose ground no longer exists rather than stubbing it', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-orphan')
    // A leaf citing a span the surface never held: nothing to resolve, and the
    // library would reject it anyway because its range cannot bound its sources.
    live.append('autobio/memory', tick({ id: 'L1-9', range: { firstSeq: ask + 500, lastSeq: answer + 500 } }))

    const { known } = seedFromLog(store, live)

    expect(seededSummaries(store)).toEqual([])
    expect(known.size).toBe(0)
  })

  it('recovers a legacy recollection\'s range from the fold node that landed it', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-legacy-headless')
    // A pre-rewrite mint, in the shape the old engine actually wrote: nothing in
    // the event says what ground it stood for, and the node that landed it names
    // the recollection only in its text. The id form matters — the old engine
    // never wrote `autobio:` into the source, so this fixture covers the reader
    // that has to fall back to the header.
    live.append('autobio/memory', tick({ id: 'L1-0' }))
    live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L1-0] the ground this stands for' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-1' },
      }),
    }, { surfaceOp: { op: 'replace', start: ask, end: answer }, sourceEventSeqs: [ask, answer] })

    seedFromLog(store, live)

    // Both nodes the fold cited, still on the surface because nothing folded over
    // them, and still in store-position order.
    const [summary] = seededSummaries(store)
    expect(summary?.sourceIds).toEqual(['record-000000000000', 'record-000000000001'])
  })

  it('reads the header past the blocks that are not text, and gives up on a node whose type it does not read', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('seed-legacy-partial'))
    live.append('turn/start', { turn: 0 })
    const ask = live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ask' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    const call = live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{}' }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq
    const result = live.append('tool/result', {
      turn: 0,
      step: 0,
      message: createToolResultMessage({ callId: CallId('call-1'), content: [{ type: 'text', text: 'output' }], isError: false }),
    }, { surfaceOp: 'append' }).seq
    // A landed node whose text does not lead, in the shape a fold node with
    // signed content takes, so the prose reader has to walk past the block
    // before the header.
    live.append('autobio/memory', tick({ id: 'L1-0' }))
    live.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'reasoning block' },
          { type: 'text', text: '[Recall L1-0] the ground this stands for' },
        ],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-partial' },
      }),
    }, { surfaceOp: { op: 'replace', start: ask, end: call }, sourceEventSeqs: [ask, call] })
    // A tool result rewritten to lead with prose that names no recollection. It
    // is a replacement node on the surface, so the reader has to give up on it by
    // type: reading its text would hand some recollection a range out of a node
    // that stands for none of it. The session compares the replaced event against
    // the replacement with only the block's body nulled, so a content rewrite
    // reuses the original block's shape.
    const landed = live.events.find(event => event.seq === result)
    if (landed?.type !== 'tool/result') throw new Error('the tool result did not land')
    const [block] = landed.data.message.content
    const rewrite = (from: number, text: string): number => live.append('tool/result', {
      turn: 0,
      step: 0,
      message: { ...landed.data.message, content: [{ ...block, content: [{ type: 'text', text }] }] },
    }, { surfaceOp: { op: 'replace', start: from, end: from }, sourceEventSeqs: [from] }).seq
    // No header at all, then a bracket that opens one and names nothing.
    const blanked = rewrite(result, 'rewritten output')
    rewrite(blanked, '[Recall] rewritten output')
    // A recollection nothing in the log says it landed: the node that would
    // answer for it is the one the reader just gave up on.
    live.append('autobio/memory', tick({ id: 'L1-1' }))

    seedFromLog(store, live)

    // Only the assistant node answered for a recollection: it is the one landing
    // on the ground `L1-0` stands for, and `L1-1` has no node at all.
    expect(seededSummaries(store).map(entry => [entry.id, entry.sourceIds])).toEqual([
      ['L1-0', ['record-000000000000', 'record-000000000001']],
    ])
  })

  it('gives up on a landed node whose text opens no header', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-legacy-noheader')
    // A recollection naming neither its id in a `compactionId` nor its ground in
    // the prose. It is the shape a response carrying captured reasoning takes:
    // the blocks replay verbatim, so the header has no room. Nothing recovered it,
    // and nothing should: the only node over its ground says it stands for another
    // recollection, so handing `L1-1` a range would be reading a node's text as a
    // claim it does not make.
    live.append('autobio/memory', tick({ id: 'L1-1' }))
    live.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L1-0] captured reasoning, no header of its own' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-noheader' },
      }),
    }, { surfaceOp: { op: 'replace', start: answer, end: answer }, sourceEventSeqs: [answer] })
    // A recollection of its own, standing over the ground next door, and one that
    // named itself in a `compactionId` rather than in the prose.
    live.append('autobio/memory', tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: ask } }))
    live.append('assistant/message', {
      turn: 0,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'the ground this stands for, named in its source' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio:L1-0' },
      }),
    }, { surfaceOp: { op: 'replace', start: ask, end: ask }, sourceEventSeqs: [ask] })

    seedFromLog(store, live)

    // The recollection that named itself in its source is the only one recovered,
    // and it stands over the ground its own node took. Reading the headerless node
    // as prose would not merely add a recollection: it would hand `L1-1` a range
    // out of a node standing for another recollection, and `L1-0` a range of the
    // whole exchange rather than the ask it actually replaced.
    const summaries = seededSummaries(store)
    expect(summaries.map(entry => [entry.id, entry.sourceIds])).toEqual([
      ['L1-0', ['record-000000000000']],
    ])
  })

  it('reads a parent\'s coverage through the child fold node it cites', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-legacy-nested')
    // A level-1 fold over the exchange, then a level-2 fold whose only citation
    // is that node. The log writes it this way: a parent cites its children's
    // *nodes*, which sit at the bounds of the interval it names, so reading the
    // citations as seqs would report ground the parent never took. Measured on
    // the red-lemma log, 36 of its 160 fold nodes cite an earlier fold's node.
    const child = foldNode(live, 'L1-0', [ask, answer])
    live.append('autobio/memory', tick({ id: 'L2-0', level: 2 }))
    live.append('assistant/message', {
      turn: 0,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L2-0] the ground its child already took' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-L2-0' },
      }),
    }, { surfaceOp: { op: 'replace', start: child, end: child }, sourceEventSeqs: [child] })

    seedFromLog(store, live)

    // The parent stands for its child, not for the node standing in for it: the
    // expansion turns the single citation back into the messages underneath.
    const summaries = seededSummaries(store)
    expect(summaries.map(entry => [entry.id, entry.sourceIds])).toEqual([
      ['L1-0', ['record-000000000000', 'record-000000000001']],
      ['L2-0', ['L1-0']],
    ])
    // The bounds say the same story: the parent is bounded by its child's
    // *record*, not by the child's node. The node sits at `child`, well after
    // the exchange, so reading the citation as a seq would bound the parent at
    // the node instead of at the ground that node stands for.
    const bounds = new Map(
      (store.getStateJson(slots().summaries.id) as SummaryEntry[]).map(entry => [entry.id, entry.sourceRange]),
    )
    expect(bounds.get('L2-0')).toEqual({ first: 'L1-0', last: 'L1-0' })
    expect(child).toBeGreaterThan(answer)
  })

  it('does not let one recollection\'s fold node stand in for another', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-legacy-mismatch')
    live.append('autobio/memory', tick({ id: 'L1-0' }))
    live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L1-0] text naming a different recollection' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio:L1-7' },
      }),
    }, { surfaceOp: { op: 'replace', start: ask, end: answer }, sourceEventSeqs: [ask, answer] })

    seedFromLog(store, live)

    // The node landed L1-7. Its prose happens to name L1-0, which is not a
    // record of anything — the compaction id is.
    expect(seededSummaries(store)).toEqual([])
  })

  it('takes the level from the id when the mint did not record a usable one', () => {
    const { session: live, ask, answer } = session('seed-level-from-id')
    live.append('autobio/memory', tick({ id: 'L3-2', level: 0, range: { firstSeq: ask, lastSeq: answer } }))

    expect(readMemoryLog(live)[0]?.level).toBe(3)
  })

  it('reads a recollection whose id follows neither convention', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-conventionless-id')
    // A log from an engine that numbered recollections its own way: no trailing
    // index to resume the counter from, and no level prefix to read.
    live.append('autobio/memory', tick({ id: 'first-memory', level: 0, range: { firstSeq: ask, lastSeq: answer } }))

    seedFromLog(store, live)

    expect(readMemoryLog(live)[0]?.level).toBe(1)
    // The counter stays where it was rather than becoming NaN.
    expect(store.getStateJson(slots().counter.id)).toBe(0)
  })

  it('keeps the first mint of an id a pre-rewrite log recorded twice', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-duplicate')
    const first = tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: ask } })
    const second = { ...tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }) }
    ;(second.memory as AutobiographicalMemoryMint).content = 'rewritten'
    live.append('autobio/memory', first)
    live.append('autobio/memory', second)

    seedFromLog(store, live)

    const summaries = seededSummaries(store)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toBe('content of L1-0')
  })

  it('ignores an unrelated event that shares the memory event\'s shape', () => {
    const store = new LogStore()
    const { session: live } = session('seed-unrelated')
    // A tick that minted nothing still records progress; it names no recollection.
    const stats = tick({ id: 'L1-0' })
    delete stats.memory
    live.append('autobio/memory', stats)

    seedFromLog(store, live)

    expect(seededSummaries(store)).toEqual([])
  })

  it('resumes the mint counter above every recollection the log holds', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-counter')
    live.append('autobio/memory', tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }))
    live.append('autobio/memory', tick({ id: 'L1-4', range: { firstSeq: ask, lastSeq: answer } }))

    seedFromLog(store, live)

    // One past the highest index, so a resumed run cannot re-issue an id.
    expect(store.getStateJson(slots().counter.id)).toBe(5)
  })
})

describe('appendSurfaceNode', () => {
  it('mirrors a live append with the store\'s own id, so live and replay agree', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('append-live'))
    const ids = slots()
    store.registerState(ids.messages)
    const ask = live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ask' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const id = appendSurfaceNode(store, live, ask)

    expect(id).toBeDefined()
    const messages = store.getStateJson(MESSAGES_STATE) as Record<string, unknown>[]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe(id)
    expect(messages[0]?.participant).toBe('user')
    expect(messages[0]?.metadata).toEqual({ dshSeq: ask.seq })
    expect(messages[0]?.timestamp).toEqual(new Date(ask.time))
  })

  it('contributes no node for a step that carries no message', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('append-usage-only'))
    const ids = slots()
    store.registerState(ids.messages)
    // A max-tokens step exists to bill usage and carries no content; it must
    // not occupy a surface position.
    const step = live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [] as ContentBlock[],
        source: { provider: 'test', model: 'test-model' },
      }),
      usage: { inputTokens: 10, outputTokens: 1 },
    }, { surfaceOp: 'append' })

    expect(appendSurfaceNode(store, live, step)).toBeUndefined()
    expect(store.getStateJson(MESSAGES_STATE)).toEqual([])
  })
})
