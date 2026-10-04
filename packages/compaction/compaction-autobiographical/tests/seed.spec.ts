/**
 * Log replay: the half of the archive that is not the schema.
 *
 * Every case here is about what a *restart* does with a log someone else wrote,
 * so the fixtures build sessions by hand and assert on the store seeding leaves
 * behind. The engine specs prove folding works; these prove that folding
 * survives the process that produced it going away.
 */

import type { MessageId, SummaryEntry } from '@animalabs/context-manager'
import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { appendSurfaceNode, readMemoryLog, resolveRange, seedFromLog } from '../src/seed.ts'
import { createStore, LogStore, MESSAGES_STATE, slots } from '../src/store.ts'
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

/** A recollection carrying the fields a range read touches. */
function summary(id: string, level: number, overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id, level, content: `content of ${id}`, tokens: 12, created: 1_700_000_000_000,
    sourceLevel: 0, sourceIds: [], sourceRange: { first: id, last: id },
    ...overrides,
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
    // Two children with a fold node each. What places a child inside the parent above
    // it is the ground the child stands over, which is what the parent's own range is
    // built from: resolving a child's id through the pyramid yields its ground.
    foldNode(live, 'L1-0', [ask, answer])
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
    foldNode(live, 'L1-1', [later], 1)
    // The parent's own interval: the union of the ground its children stand over. It
    // reaches forward from the first child's exchange to the message the second one
    // distilled.
    live.append('autobio/memory', tick({ id: 'L2-0', level: 2, range: { firstSeq: ask, lastSeq: later } }))

    seedFromLog(store, live)

    const byId = new Map(seededSummaries(store).map(summary => [summary.id, summary]))
    expect(byId.get('L2-0')?.sourceIds).toEqual(['L1-0', 'L1-1'])
    expect(byId.get('L2-0')?.sourceLevel).toBe(1)
    // The messages its children stand for, not the children: upstream stamps a merge
    // with the leaves under its first and last source, and `recallCurveLeafIds` reads
    // a range naming anything else as an entry whose leaves are not walkable.
    expect(byId.get('L2-0')?.sourceRange).toEqual({
      first: 'record-000000000000',
      last: 'record-000000000002',
    })
  })

  it('keeps both layers when a parent cites a recollection that only re-took its child', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-equal-spans')
    // A legacy fold whose node cites its one child's node and nothing older, so the
    // ground it stands over is exactly that child's. That makes the two of them equal
    // rather than nested, and a parent reaching that ground takes both: reading one as
    // the other's layer would drop a recollection the parent's own interval covers.
    const child = foldNode(live, 'L1-0', [ask, answer])
    live.append('autobio/memory', tick({ id: 'L2-0', level: 2 }))
    live.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L2-0] the same ground again' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-L2-0' },
      }),
    }, { surfaceOp: { op: 'replace', start: child, end: child }, sourceEventSeqs: [child] })

    seedFromLog(store, live)

    const byId = new Map(seededSummaries(store).map(summary => [summary.id, summary]))
    expect(byId.get('L1-0')?.sourceIds).toEqual(['record-000000000000', 'record-000000000001'])
    expect(byId.get('L2-0')?.sourceIds).toEqual(['L1-0'])
    expect(byId.get('L2-0')?.sourceRange).toEqual({ first: 'record-000000000000', last: 'record-000000000001' })
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
    expect(bounds.get('L2-0')).toEqual({ first: 'record-000000000000', last: 'record-000000000001' })
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

  it('keeps the newest mint of an id a pre-rewrite log recorded twice', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-duplicate')
    // Two mints of one id, both carrying a range: only one recollection ever had
    // this name, and the newest account of it is the one the log ends with.
    const first = tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: ask } })
    const second = { ...tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }) }
    ;(second.memory as AutobiographicalMemoryMint).content = 'rewritten'
    live.append('autobio/memory', first)
    live.append('autobio/memory', second)

    seedFromLog(store, live)

    const summaries = seededSummaries(store)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toBe('rewritten')
    expect(summaries[0]?.sourceRange).toEqual({ first: 'record-000000000000', last: 'record-000000000001' })
  })

  it('lets a mint that states its range displace an earlier one that does not', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-duplicate-ranged')
    // A log that records one id twice, the second time with the range the first
    // omitted. Keeping the first would leave ground the log does state uncited, and
    // seeding drops what it cannot place — the recollection would come back with no
    // coverage on the reopen that reads this log.
    const bare = tick({ id: 'L1-0' })
    const stated = { ...tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }) }
    ;(stated.memory as AutobiographicalMemoryMint).content = 'the mint that states its range'
    live.append('autobio/memory', bare)
    live.append('autobio/memory', stated)

    seedFromLog(store, live)

    const summaries = seededSummaries(store)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toBe('the mint that states its range')
    expect(summaries[0]?.sourceIds).toEqual(['record-000000000000', 'record-000000000001'])
  })

  it('never lets a later range-less mint displace a ranged one', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-duplicate-late-bare')
    const stated = tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } })
    live.append('autobio/memory', stated)
    live.append('autobio/memory', tick({ id: 'L1-0' }))

    seedFromLog(store, live)

    const summaries = seededSummaries(store)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.sourceIds).toEqual(['record-000000000000', 'record-000000000001'])
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

  it('counts the recollections seeding drops, because they own their ids', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('seed-counter-dropped')
    live.append('autobio/memory', tick({ id: 'L1-0', range: { firstSeq: ask, lastSeq: answer } }))
    // A recollection the log names but nothing on the surface accounts for: seeding
    // drops it, and it still holds its index. Advancing the counter only over what
    // survives would put the next mint back on `L1-5`, writing a second recollection
    // under a name the log already used — and the deduplication that reads this log
    // back would then keep whichever record it prefers.
    live.append('autobio/memory', tick({ id: 'L1-5', range: { firstSeq: ask + 900, lastSeq: answer + 900 } }))
    live.append('autobio/memory', tick({ id: 'L1-1', range: { firstSeq: ask, lastSeq: answer } }))

    seedFromLog(store, live)

    expect(seededSummaries(store).map(entry => entry.id)).toEqual(['L1-0', 'L1-1'])
    expect(store.getStateJson(slots().counter.id)).toBe(6)
  })

  it('stores the library\'s block vocabulary, not the harness\'s', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('seed-vocabulary'))
    live.append('turn/start', { turn: 0 })
    live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'weighing the read' },
          { type: 'tool-call', id: CallId('call-1'), name: 'read', arguments: '{"path":"a.ts"}' },
        ],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    live.append('tool/result', {
      turn: 0,
      step: 0,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'the file' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    seedFromLog(store, live)

    const messages = store.getStateJson(MESSAGES_STATE) as Array<{ content: unknown[] }>
    // The library reads its own names only: under the harness's, these blocks
    // price at zero tokens, match no tool pair and carry no tool a chunk can see.
    expect(messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'weighing the read' },
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.ts' } },
    ])
    expect(messages[1]?.content).toEqual([
      { type: 'tool_result', toolUseId: 'call-1', content: [{ type: 'text', text: 'the file' }], isError: false },
    ])
  })

  it('stores arguments that are not a JSON object as an empty input', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('seed-arguments'))
    live.append('turn/start', { turn: 0 })
    // A call the model truncated: the list is a JSON value but not an object, and
    // the text is not JSON at all. Neither is tool input, so neither is stored.
    const calls = [
      { id: 'list', arguments: '[1,2]' },
      { id: 'garbage', arguments: 'not json' },
    ]
    for (const call of calls) {
      live.append('assistant/message', {
        turn: 0,
        step: 0,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: CallId(call.id), name: 'read', arguments: call.arguments }],
          source: { provider: 'test', model: 'test-model' },
        }),
      }, { surfaceOp: 'append' })
    }

    seedFromLog(store, live)

    const messages = store.getStateJson(MESSAGES_STATE) as Array<{ content: Array<{ input: unknown }> }>
    expect(messages.map(message => message.content[0]?.input)).toEqual([{}, {}])
  })

  it('replaces a block the store cannot represent with a placeholder', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('seed-attachment'))
    live.append('turn/start', { turn: 0 })
    live.append('user/message', createUserMessage({
      content: [
        // The harness carries a durable reference here, never the bytes: what a
        // recollection can preserve is the fact of the attachment.
        {
          type: 'image',
          attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
        } as unknown as ContentBlock,
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    seedFromLog(store, live)

    const messages = store.getStateJson(MESSAGES_STATE) as Array<{ content: unknown[] }>
    expect(messages[0]?.content).toEqual([{ type: 'text', text: '[image omitted from memory mirror]' }])
  })

  it('stores a row the slot can hold, not the frozen content the session wrote', () => {
    const store = new LogStore()
    const { session: live, ask } = session('seed-json')
    seedFromLog(store, live)

    const [row] = store.getStateJson(MESSAGES_STATE) as Array<Record<string, unknown>>
    const [block] = row?.content as unknown[]
    // The session freezes what it publishes, and the library edits the messages it
    // materializes from this slot, so the row is a fresh JSON-shaped copy. The
    // clock is the event's own, in the milliseconds `MessageStore` also writes.
    expect(row?.['timestamp']).toBe((live.events.find(candidate => candidate.seq === ask) as { time: number }).time)
    expect(Object.isFrozen(block)).toBe(false)
    expect(Object.getPrototypeOf(block)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(row))).toEqual(row)
    const event = live.events.find(candidate => candidate.seq === ask)
    expect(event?.type === 'user/message' && Object.isFrozen(event.data.content[0])).toBe(true)
  })

  it('skips an appended message with no blocks, as the live path does', () => {
    const store = new LogStore()
    const live = Session.create(SessionId('seed-empty-content'))
    live.append('turn/start', { turn: 0 })
    const ask = live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ask' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    // An event that derives a message carrying no blocks: a row for it would stand
    // for nothing the memory system can price, chunk or remember.
    live.append('user/message', createUserMessage({
      content: [] as ContentBlock[],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const answer = live.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'answer' }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' }).seq

    const { seqOf } = seedFromLog(store, live)

    // The two events that carry blocks keep the ids they would have had, so a
    // second open numbers the same rows and a minted range still resolves.
    expect([...seqOf.entries()]).toEqual([
      ['record-000000000000', ask],
      ['record-000000000001', answer],
    ])
    const again = new LogStore()
    seedFromLog(again, live)
    expect(again.getStateJson(MESSAGES_STATE)).toEqual(store.getStateJson(MESSAGES_STATE))
  })
})

describe('resolveRange', () => {
  it('resolves a recollection whose sources are other recollections, not messages', () => {
    const store = new LogStore()
    const { session: live, ask } = session('resolve-nested')
    const { seqOf } = seedFromLog(store, live)
    const first = [...seqOf.keys()][0] as string

    // The library's own `sourceIds` are message ids at level 1 and *summary ids*
    // above it (`strategy.d.ts:1176`). A recollection built on another
    // recollection therefore names nothing `seqOf` holds, and reading only that
    // map reports no range — which is what left level-3 recollections unable to
    // stand over the ground the picker had resolved to them.
    const child = summary('L1-0', 1, { sourceIds: [first], sourceRange: { first, last: first } })
    const parent = summary('L2-0', 2, {
      sourceLevel: 1,
      sourceIds: [child.id],
      sourceRange: { first: child.id, last: child.id },
    })
    store.appendToStateJson(slots().summaries.id, child)
    store.appendToStateJson(slots().summaries.id, parent)

    const rows = seededSummaries(store)
    expect(seqOf.get(first)).toBe(ask)
    expect(resolveRange(seqOf, child, rows)).toEqual({ firstSeq: ask, lastSeq: ask })
    // The same recollection read twice resolves once out of the memo rather than
    // walking its chain again.
    expect(resolveRange(seqOf, parent, rows)).toEqual({ firstSeq: ask, lastSeq: ask })
    expect(resolveRange(seqOf, parent, rows)).toEqual({ firstSeq: ask, lastSeq: ask })
    // Without the rows there is no chain to walk, so the refusal still stands —
    // the caller that holds only the message map gets no invented range.
    expect(resolveRange(seqOf, parent)).toBeUndefined()
  })

  it('walks a chain of recollections to the ground a level-3 stands over', () => {
    const store = new LogStore()
    const { session: live, ask, answer } = session('resolve-chain')
    const { seqOf } = seedFromLog(store, live)
    const first = [...seqOf.keys()][0] as string
    const second = [...seqOf.keys()][1] as string

    // The shape the library writes for a pyramid: level 1 names messages, and
    // every level above names the recollections beneath it. An L3 therefore
    // reaches the ground only by walking two hops, and a reader that stops at the
    // message map returns nothing for it — which is how a level-3 recollection
    // came to stand over no ground at all while the picker kept resolving messages
    // to it, failing every pass with "no level-3 recollection stands for log seq".
    const child = summary('L1-0', 1, { sourceIds: [first, second], sourceRange: { first, last: second } })
    const middle = summary('L2-0', 2, {
      sourceLevel: 1,
      sourceIds: [child.id],
      sourceRange: { first: child.id, last: child.id },
    })
    const top = summary('L3-0', 3, {
      sourceLevel: 2,
      sourceIds: [middle.id],
      sourceRange: { first: middle.id, last: middle.id },
    })
    const self = summary('L2-1', 2, { sourceLevel: 1, sourceIds: ['L2-1'] })
    for (const row of [child, middle, top, self]) store.appendToStateJson(slots().summaries.id, row)
    const rows = seededSummaries(store)

    expect(resolveRange(seqOf, top, rows)).toEqual({ firstSeq: ask, lastSeq: answer })
    // A recollection naming itself has no ground under it, and the walk says so
    // rather than following its own citation forever.
    expect(resolveRange(seqOf, self, rows)).toBeUndefined()
    expect(answer).toBeGreaterThan(ask)
  })
})

describe('appendSurfaceNode', () => {
  /** An open manager over an empty store, which is where a live append lands. */
  async function open(id: string): Promise<{ store: LogStore; live: Session; manager: ContextManager }> {
    const store = createStore()
    store.registerState(slots().messages)
    const live = Session.create(SessionId(id))
    const manager = await ContextManager.open({ store: store as never, strategy: new AutobiographicalStrategy({}) })
    return { store, live, manager }
  }

  it('mirrors a live append the manager can read back, with the store\'s own id', async () => {
    const { store, live, manager } = await open('append-live')
    const ask = live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ask' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const id = appendSurfaceNode(manager, live, ask)

    expect(id).toBeDefined()
    const messages = store.getStateJson(MESSAGES_STATE) as Record<string, unknown>[]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe(id)
    expect(messages[0]?.participant).toBe('user')
    expect(messages[0]?.metadata).toEqual({ dshSeq: ask.seq })
    // Milliseconds, the form `MessageStore` writes and the library's time filters
    // compare against. A live row takes the library's own clock, because
    // `addMessage` stamps it; a replayed row takes the event's.
    expect(typeof messages[0]?.timestamp).toBe('number')
    // Through `addMessage`, so the index the library resolves ids by saw the
    // write: a row appended straight to the slot leaves this read null.
    expect(manager.getMessage(id as MessageId)).toEqual(expect.objectContaining({ participant: 'user' }))
  })

  it('contributes no node for a step that carries no message', async () => {
    const { store, live, manager } = await open('append-usage-only')
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

    expect(appendSurfaceNode(manager, live, step)).toBeUndefined()
    expect(store.getStateJson(MESSAGES_STATE)).toEqual([])
  })

  it('contributes no node for an appended message that carries no block', async () => {
    const { store, live, manager } = await open('append-empty-content')
    // A user message with no blocks derives a message whose content is empty, and
    // a row for it stands for nothing the memory system can price or remember.
    // The seed path skips the same event, so a replay numbers the rows from the
    // events that carry blocks.
    const empty = live.append('user/message', createUserMessage({
      content: [] as ContentBlock[],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(appendSurfaceNode(manager, live, empty)).toBeUndefined()
    expect(store.getStateJson(MESSAGES_STATE)).toEqual([])
  })
})
