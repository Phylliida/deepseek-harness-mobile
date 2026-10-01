/**
 * Seeding is a function of the log.
 *
 * The whole rewrite rests on one claim: the session log, not an on-disk archive,
 * holds everything a reopened session needs. These cases test that claim where it
 * can actually fail. A replay that reads nodes in log order and re-derives the
 * surface passes a single fold and fails a chain; a replay that only understands
 * the current id form passes every new fold and drops every legacy one. Both
 * shapes are real: in the red-lemma session 36 of 160 fold nodes cite the
 * replacement node of an earlier fold, and all 160 name themselves the old way.
 */

import type { SummaryEntry } from '@animalabs/context-manager'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { seedFromLog } from '../src/seed.ts'
import { LogStore, slots } from '../src/store.ts'
import type { AutobiographicalMemoryEventData } from '../src/types.ts'

/** Every slot's contents, in a form two opens can be compared through. */
function snapshot(store: LogStore): string {
  const ids = slots()
  return JSON.stringify([ids.messages.id, ids.summaries.id, ids.counter.id].map(id => store.getStateJson(id)))
}

/** The summaries seeding wrote, as the library reads them back. */
function seededSummaries(store: LogStore): SummaryEntry[] {
  return store.getStateJson(slots().summaries.id) as SummaryEntry[]
}

/** One memory-formation tick, in the shape the engine's `appendMemory` writes. */
function tick(
  id: string,
  level: number,
  range?: { firstSeq: number; lastSeq: number },
): AutobiographicalMemoryEventData {
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
      id,
      level,
      content: `content of ${id}`,
      tokens: 12,
      created: 1_700_000_000_000,
      ...range === undefined ? {} : { sourceRange: range },
    },
  }
}

/** One exchange, landing on the surface and returning the seqs it produced. */
function exchange(live: Session, turn: number): { ask: number; answer: number } {
  live.append('turn/start', { turn })
  const ask = live.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `ask ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  const answer = live.append('assistant/message', {
    turn,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `answer ${turn}` }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  live.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { ask, answer }
}

/**
 * A fold node as the pre-rewrite engine wrote it: the recollection records no
 * range, the node names the recollection only in its text, and its `compactionId`
 * uses the old `autobio-session-*` form rather than `autobio:<id>`.
 */
function fold(live: Session, id: string, text: string, ground: readonly number[], turn = 0): void {
  live.append('autobio/memory', tick(id, 1))
  live.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `[Recall ${id}] ${text}` }],
      source: { provider: 'test', model: 'test-model', compactionId: `autobio-session-legacy-${id}` },
    }),
  }, {
    surfaceOp: { op: 'replace', start: ground.at(0) as number, end: ground.at(-1) as number },
    sourceEventSeqs: [...ground],
  })
}

describe('seeding is a function of the log', () => {
  it('produces the same store twice, so a reopen cannot drift from the first open', () => {
    const live = Session.create(SessionId('acceptance-repeat'))
    const first = exchange(live, 0)
    fold(live, 'L1-0', 'the ground this stands for', [first.ask, first.answer])

    const once = new LogStore()
    const again = new LogStore()
    seedFromLog(once, live)
    seedFromLog(again, live)

    // Not just equality of the summaries: the whole store, ids included. A
    // second open that numbered records differently would resolve a later range
    // against the wrong message and nothing downstream would notice.
    expect(snapshot(again)).toBe(snapshot(once))
  })

  it('resolves a fold whose ground is the replacement node of an earlier fold', () => {
    const live = Session.create(SessionId('acceptance-chain'))
    const first = exchange(live, 0)
    const second = exchange(live, 1)

    fold(live, 'L1-0', 'first ground', [first.ask, first.answer])
    // The node the first fold landed, which is what a recollection above it cites.
    const firstNode = live.events.at(-1)?.seq as number
    fold(live, 'L1-1', 'second ground', [firstNode, second.ask, second.answer], 1)
    const landed = live.events.at(-1)?.seq as number

    const store = new LogStore()
    const { known } = seedFromLog(store, live)

    expect([...known.keys()].sort()).toEqual(['L1-0', 'L1-1'])
    // Three fields, and the differences between them are the whole point. The ground
    // it stands over is the second exchange; the interval it cites reaches forward to
    // the node that landed it, because the first fold's ground was gone from the
    // surface and that node was all there was left to name for it; and `at` is the
    // seq of the node that landed it, which is how a higher recollection finds this
    // one. `at` is not inside `cited`: a fold lands after the ground it names, so the
    // node is always past the interval it cites.
    expect(known.get('L1-1')).toEqual({
      covered: { firstSeq: second.ask, lastSeq: second.answer },
      cited: { firstSeq: second.ask, lastSeq: firstNode },
      at: landed,
    })
    expect(landed).toBeGreaterThan(firstNode)

    const [low, high] = seededSummaries(store)
    expect(low?.id).toBe('L1-0')
    expect(high?.id).toBe('L1-1')
    // An entry's `sourceRange` has to bound its `sourceIds`, which is what the
    // recall curve checks before it will treat the entry as a leaf.
    for (const entry of [low, high] as SummaryEntry[]) {
      expect(entry.sourceIds.length).toBeGreaterThan(0)
      expect(entry.sourceRange.first).toBe(entry.sourceIds.at(0))
      expect(entry.sourceRange.last).toBe(entry.sourceIds.at(-1))
    }
  })

  it('stands a higher recollection over the children whose nodes its interval takes in', () => {
    // A level-2 fold comes out of the log citing the child nodes it shadowed, so a
    // parent adopts the children those nodes landed — membership is a question about
    // nodes, not about the ground they stand for. Measured on the red-lemma log,
    // where 27 level-2 recollections landed, this reading places children under 23 of
    // them and adopts 117, against 18 and 55 for nesting on the cited intervals.
    const live = Session.create(SessionId('acceptance-levels'))
    const first = exchange(live, 0)
    fold(live, 'L1-0', 'first ground', [first.ask, first.answer])
    const between = exchange(live, 1)
    fold(live, 'L1-1', 'second ground', [between.ask, between.answer], 1)

    // Minted with no range of its own, so the interval its own node cites is the only
    // thing that can place it — the child-derived path, not a second level-1 run.
    live.append('autobio/memory', tick('L2-0', 2))
    // A replace cannot name a node the surface no longer holds, so this one reaches
    // back no further than the second child's node — the furthest back the surface
    // still goes. `assertProvenance` wants every node the replace shadows named.
    const parentStart = live.events.at(-2)?.seq as number
    const shadowed = live.events.filter(event => event.seq >= parentStart && event.type === 'assistant/message')
    live.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L2-0] one child only' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio-session-legacy-L2-0' },
      }),
    }, {
      surfaceOp: { op: 'replace', start: parentStart, end: shadowed.at(-1)?.seq as number },
      sourceEventSeqs: shadowed.map(event => event.seq),
    })

    const store = new LogStore()
    const { known } = seedFromLog(store, live)

    expect([...known.keys()].sort()).toEqual(['L1-0', 'L1-1', 'L2-0'])
    // Child nodes land at 5 and 11 and the parent's replace names only 11, because the
    // surface no longer holds anything older. So the parent's interval takes in the
    // second child and not the first, and cites recollections rather than messages —
    // which is the harder half of the rule: a parent stands over what its own interval
    // reaches, and a child it cannot account for stays its own entry.
    expect(seededSummaries(store).at(-1)?.sourceIds).toEqual(['L1-1'])
    expect(seededSummaries(store).at(-1)?.sourceLevel).toBe(1)
  })

  it('leaves a recollection out rather than seeding one with no sources', () => {
    // Ground that no node on the surface accounts for: the mint names a range but
    // nothing was ever appended there. Seeding an entry with no `sourceIds` would
    // hand the recall curve an entry it rejects, so the recollection is dropped
    // and the planner is free to cover the ground again.
    const live = Session.create(SessionId('acceptance-uncovered'))
    const only = exchange(live, 0)
    live.append('autobio/memory', tick('L1-0', 1, { firstSeq: only.answer + 100, lastSeq: only.answer + 200 }))

    const store = new LogStore()
    const { seqOf, known } = seedFromLog(store, live)

    expect(seqOf.size).toBe(2)
    expect(known.size).toBe(0)
    expect(seededSummaries(store)).toEqual([])
  })
})
