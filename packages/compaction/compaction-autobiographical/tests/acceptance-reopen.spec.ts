/**
 * A reopen of a settled pyramid: what the log has to carry for the next process to
 * pick the session up where it was left, and what opening it costs.
 *
 * Every other fixture in this package stops at one process. These start where the
 * archive actually gets read — a log holding landings, mints and merges that a
 * later process replays — and hold the backend to the headline claim: reopening a
 * session that has already folded its history costs zero inference calls. The
 * fixture writes what the engine writes, event for event, so what it pins is the
 * log's contract rather than a second implementation of the engine.
 */

import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager'
import type { SummaryEntry } from '@animalabs/context-manager'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { foldIdOf } from '../src/plan.ts'
import { seedFromLog } from '../src/seed.ts'
import { createStore, slots } from '../src/store.ts'
import type { LogStore } from '../src/store.ts'
import type { AutobiographicalMemoryEventData } from '../src/types.ts'
import { build, reopen } from './harness.ts'

/** One recollection the fixture landed, with the ground it covers and its node. */
interface Landed {
  /** Log seqs of the messages the recollection stands over, first and last. */
  readonly ground: { readonly firstSeq: number; readonly lastSeq: number }
  /** Log seq of the fold node that landed it. */
  readonly node: number
}

/** One memory-formation tick, in the shape the engine's `appendMemory` writes it. */
function mint(id: string, level: number, range: { firstSeq: number; lastSeq: number }): AutobiographicalMemoryEventData {
  return {
    chunksTotal: 1,
    chunksCompressed: 0,
    compressionCount: 0,
    l1: level,
    l2: 0,
    l3: 0,
    pendingMerges: 0,
    attempt: 1,
    memory: { id, level, content: `content of ${id}`, tokens: 12, created: 1_700_000_000_000, sourceRange: range },
  }
}

/**
 * A session that folds its own history the way the engine does: one recollection
 * per exchange, then one recollection per pack of them.
 *
 * The ranges are the engine's own resolution, not the node positions it lands on: a
 * recollection is stamped with the ground its sources cover, which for a recollection
 * of recollections is the union of theirs. The fold node still replaces the nodes it
 * cites, because that is what a replace acts on.
 */
function pyramid(id: string, options: { exchanges: number; pack: number }): Session {
  const live = Session.create(SessionId(id))
  live.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })

  /** Land one recollection over the nodes it cites, returning what it covers and where it landed. */
  const fold = (memoryId: string, level: number, children: readonly Landed[], turn: number): Landed => {
    const cited = [...new Set(children.map(child => child.node))].sort((a, b) => a - b)
    const ground = {
      firstSeq: Math.min(...children.map(child => child.ground.firstSeq)),
      lastSeq: Math.max(...children.map(child => child.ground.lastSeq)),
    }
    live.append('autobio/memory', mint(memoryId, level, ground))
    const node = live.append('assistant/message', {
      turn,
      step: level,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `[Recall ${memoryId}] the ground this stands for` }],
        source: { provider: 'test', model: 'test-model', compactionId: `autobio:${memoryId}` },
      }),
    }, {
      surfaceOp: { op: 'replace', start: cited.at(0) as number, end: cited.at(-1) as number },
      sourceEventSeqs: cited,
    }).seq
    return { ground, node }
  }

  const level1: Landed[] = []
  for (let turn = 0; turn < options.exchanges; turn++) {
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
    // A replace names every node it shadows, so the recollection stands over the whole
    // exchange rather than one message of it.
    const outside = live.surface.nodes.filter(seq => seq >= ask && seq <= answer)
    live.append('autobio/memory', mint(`L1-${turn}`, 1, { firstSeq: ask, lastSeq: answer }))
    const node = live.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `[Recall L1-${turn}] the ground this stands for` }],
        source: { provider: 'test', model: 'test-model', compactionId: `autobio:L1-${turn}` },
      }),
    }, {
      surfaceOp: { op: 'replace', start: ask, end: answer },
      sourceEventSeqs: outside,
    }).seq
    level1.push({ ground: { firstSeq: ask, lastSeq: answer }, node })
  }

  for (let index = 0; index * options.pack < level1.length; index++) {
    const children = level1.slice(index * options.pack, (index + 1) * options.pack)
    if (children.length < options.pack) break
    fold(`L2-${index}`, 2, children, options.exchanges - 1)
  }
  return live
}

/** The seeded rows, as the library reads them back. */
function rows(store: LogStore): SummaryEntry[] {
  return store.getStateJson(slots().summaries.id) as SummaryEntry[]
}

/** A strategy as the engine configures it, minus the model calls. */
function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    compressionModel: 'test-model',
    summaryParticipant: 'assistant',
    adaptiveResolution: true,
    autoTickOnNewMessage: false,
  })
}

/** A pyramid of twelve level-1 recollections packed six at a time into level 2. */
function settled(): LogStore {
  const store = createStore()
  seedFromLog(store, pyramid('reopen-settled', { exchanges: 12, pack: 6 }))
  return store
}

describe('a pyramid replayed from the log', () => {
  it('stamps every merged child with its parent, so the pyramid reads as consolidated', () => {
    const byId = new Map(rows(settled()).map(entry => [entry.id, entry]))

    // The pointer is what the library reads to decide what is left to consolidate:
    // `getSummaryParentId` on the adaptive path and `mergedInto` directly on the
    // merge ladder. A covered child without it is an unmerged backlog. The seed
    // writes the same field upstream's own merge path writes, which the library's
    // type marks deprecated in favour of `parentId` that nothing stamps.
    /* oxlint-disable typescript/no-deprecated -- the field the merge ladder reads */
    for (let index = 0; index < 6; index++) expect(byId.get(`L1-${index}`)?.mergedInto).toBe('L2-0')
    for (let index = 6; index < 12; index++) expect(byId.get(`L1-${index}`)?.mergedInto).toBe('L2-1')
    // A recollection nothing above it names stands on its own.
    expect(byId.get('L2-0')?.mergedInto).toBeUndefined()
    expect(byId.get('L2-1')?.mergedInto).toBeUndefined()
    /* oxlint-enable typescript/no-deprecated */
  })

  it('binds a recollection to the deepest parent the log names for it', () => {
    // Every level names the recollections it absorbed, so a pyramid three deep names
    // each leaf twice. The entry that stands over a leaf's ground is the one nothing
    // above it names: pointing a leaf at an intermediate parent leaves the intermediate
    // standing for ground the level above it already consolidated.
    const live = pyramid('reopen-deep', { exchanges: 4, pack: 2 })
    const packed = live.events.flatMap(event => event.type === 'autobio/memory' && event.data.memory?.level === 2
      ? [event.data.memory]
      : [])
    const nodes = ['L2-0', 'L2-1'].map(id => live.events
      .filter(event => event.type === 'assistant/message')
      .find(event => foldIdOf(event) === id)?.seq as number)
    live.append('autobio/memory', mint('L3-0', 3, {
      firstSeq: Math.min(...packed.map(memory => memory.sourceRange?.firstSeq as number)),
      lastSeq: Math.max(...packed.map(memory => memory.sourceRange?.lastSeq as number)),
    }))
    live.append('assistant/message', {
      turn: 3,
      step: 3,
      message: createAssistantMessage({
        content: [{ type: 'text', text: '[Recall L3-0] the ground this stands for' }],
        source: { provider: 'test', model: 'test-model', compactionId: 'autobio:L3-0' },
      }),
    }, {
      surfaceOp: { op: 'replace', start: nodes.at(0) as number, end: nodes.at(-1) as number },
      sourceEventSeqs: [...nodes],
    })

    const store = createStore()
    seedFromLog(store, live)
    const byId = new Map(rows(store).map(entry => [entry.id, entry]))

    /* oxlint-disable typescript/no-deprecated -- the field the merge ladder reads */
    expect(byId.get('L2-0')?.mergedInto).toBe('L3-0')
    expect(byId.get('L2-1')?.mergedInto).toBe('L3-0')
    for (let index = 0; index < 4; index++) expect(byId.get(`L1-${index}`)?.mergedInto).toBe('L3-0')
    expect(byId.get('L3-0')?.mergedInto).toBeUndefined()
    /* oxlint-enable typescript/no-deprecated */
  })

  it('bounds a level-2 by the messages beneath it, not by the recollections it names', () => {
    const byId = new Map(rows(settled()).map(entry => [entry.id, entry]))

    // `recallCurveLeafIds` walks a merge down to leaf messages and reads nothing but
    // their ends. A range naming child recollection ids leaves the entry with no
    // walkable leaves, so `listSummariesInRange` skips it and a level-3 merge over it
    // fails its own source validation.
    expect(byId.get('L2-0')?.sourceRange).toEqual({ first: 'record-000000000000', last: 'record-00000000000b' })
    expect(byId.get('L2-1')?.sourceRange).toEqual({ first: 'record-00000000000c', last: 'record-000000000017' })
    const leaves = (byId.get('L2-0')?.sourceIds ?? []).flatMap(id => byId.get(id)?.sourceIds ?? [])
    expect(leaves.at(0)).toBe(byId.get('L2-0')?.sourceRange.first)
    expect(leaves.at(-1)).toBe(byId.get('L2-0')?.sourceRange.last)
  })

  it('opens the pyramid with no merge over ground the log already merged', async () => {
    const store = settled()
    const manager = await ContextManager.open({ store: store as never, strategy: strategy() })

    // Six unmerged level-1 recollections is what a repopulated queue is: the
    // library's threshold pass finds them, asks for a merge over ground the log has
    // already merged, and pays one compression call per reopen for it.
    expect((manager.getStrategy() as unknown as { mergeQueue: unknown[] }).mergeQueue).toEqual([])
    // The queue is the shape of the failure; the count is what it would cost.
    expect(manager.getMessageCount()).toBe(24)
    manager.close()
  })

  it('reopens a session the engine settled without calling the model again', async () => {
    // The pyramid a first process leaves behind, formed by the engine itself: every
    // event in the log is the real write path rather than a fixture's reading of it.
    // mergeThreshold 2 makes the run consolidate as it goes, so the log it
    // leaves is the realistic shape: a three-level pyramid with every level
    // landed, not a frontier of exactly one merge's worth of recollections
    // (which the reload gate does not re-queue, stamped or not, and so proves
    // nothing with). The window is wide because a pass whose compile refuses
    // kicks no tick, and memory formation — the merges this run lives on — is
    // tick work.
    const first = build(8, 'reopen-cost', {
      operatingWindowTokens: 900,
      strategy: { recentWindowTokens: 0, targetChunkTokens: 150, minChunkCharsForLLM: 0, mergeThreshold: 2 },
    })
    // Driven here rather than through `settle` because a merge tick is two model
    // calls behind the mint that queued it: the log is settled when a pass and
    // its trailing wait leave it untouched, with a wait long enough for the
    // chain to land.
    let previous = -1
    for (let pass = 0; pass < 8 && first.session.events.length !== previous; pass++) {
      previous = first.session.events.length
      await first.engine.compactIfNeeded(first.agent, 'pressure', new AbortController().signal)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const mints = first.session.events.filter(event => event.type === 'autobio/memory')
    expect(mints.length).toBeGreaterThan(0)
    // Without a merged level in the log the reopen proves nothing: an L1-only
    // pyramid has nothing to re-merge whether or not the links were rebuilt.
    expect(mints.some(event => event.data.memory?.level === 3)).toBe(true)

    // A second process over the same log, with a summarizer that records what it is
    // asked for. Replay reads the surface and the pyramid; neither is a model call.
    // The strategy options are the run's own: a merge threshold the reopen does not
    // inherit would leave the re-merge this test counts gated behind a longer queue.
    const second = reopen(first.session, {
      operatingWindowTokens: 900,
      strategy: { recentWindowTokens: 0, targetChunkTokens: 150, minChunkCharsForLLM: 0, mergeThreshold: 2 },
    })
    await second.engine.compactIfNeeded(second.agent, 'pressure', new AbortController().signal)
    // The tick that would re-merge runs after the pass returns; give it its turn
    // before counting calls.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(second.calls).toEqual([])
  })
})

describe('a mint nothing has folded yet', () => {
  /**
   * A level-2 the log minted with no node landed. Its children stand on the surface
   * as their own nodes, and its stamp covers the ground they stand for: the range
   * resolves through the pyramid, and a child's range is the ground it distilled.
   */
  function unfolded(): LogStore {
    const live = Session.create(SessionId('reopen-unfolded'))
    live.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
    const ground: Array<{ firstSeq: number; lastSeq: number }> = []
    for (let turn = 0; turn < 2; turn++) {
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
      live.append('autobio/memory', mint(`L1-${turn}`, 1, { firstSeq: ask, lastSeq: answer }))
      live.append('assistant/message', {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `[Recall L1-${turn}] the ground this stands for` }],
          source: { provider: 'test', model: 'test-model', compactionId: `autobio:L1-${turn}` },
        }),
      }, {
        surfaceOp: { op: 'replace', start: ask, end: answer },
        sourceEventSeqs: live.surface.nodes.filter(seq => seq >= ask && seq <= answer),
      })
      ground.push({ firstSeq: ask, lastSeq: answer })
    }
    live.append('autobio/memory', mint('L2-0', 2, {
      firstSeq: Math.min(...ground.map(entry => entry.firstSeq)),
      lastSeq: Math.max(...ground.map(entry => entry.lastSeq)),
    }))

    const store = createStore()
    seedFromLog(store, live)
    return store
  }

  it('finds its children under a range that names their ground', () => {
    const byId = new Map(rows(unfolded()).map(entry => [entry.id, entry]))

    // Child resolution measured a child's *node* against the parent's interval, and a
    // node's seq always exceeds everything it shadows: the last child of an unfolded
    // parent fell outside its own range by construction, the level-2 came back citing
    // nothing, and seeding dropped it — the recollection left the archive on every
    // reopen that read this log.
    expect(byId.get('L2-0')?.sourceIds).toEqual(['L1-0', 'L1-1'])
    expect(byId.get('L2-0')?.sourceLevel).toBe(1)
    expect(byId.get('L2-0')?.sourceRange).toEqual({ first: 'record-000000000000', last: 'record-000000000003' })
    /* oxlint-disable typescript/no-deprecated -- the field the merge ladder reads */
    expect(byId.get('L1-0')?.mergedInto).toBe('L2-0')
    expect(byId.get('L1-1')?.mergedInto).toBe('L2-0')
    /* oxlint-enable typescript/no-deprecated */
  })
})
