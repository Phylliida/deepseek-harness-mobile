/**
 * Rebuild the scratch store's memory system from the session log.
 *
 * Two passes, both idempotent:
 *
 * 1. History replay — walk the log's append events and append each one's derived
 *    message to the `messages` slot, in seq order. Replacements are skipped: a
 *    fold node is not mirrored, so the strategy replans over the originals it
 *    stands for. The planner then finds the ground already covered (`standsOver`)
 *    and asks for no fold there, which is what keeps a replay from re-minting
 *    everything a previous run folded.
 * 2. Memory replay — every `autobio/memory` event becomes a `SummaryEntry`. A
 *    recollection cannot be derived (minting calls a model), so the event
 *    payload *is* the archive: content, level, and the seq range it covered.
 *
 * The chunks slot stays empty on purpose. `AutobiographicalStrategy` synthesizes
 * chunk records from L1 `sourceIds` whenever it finds L1s and no chunks
 * (`migrateChunkRecords`), then `rebuildChunks` spreads them over the live
 * messages — so re-deriving them here would duplicate a migration the library
 * already performs.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/seed
 */

import type { SummaryEntry } from '@animalabs/context-manager'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { foldIdOf } from './plan.ts'
import { LogStore, slots } from './store.ts'
import type { RecollectionRange } from './types.ts'

/** A recollection as the log records it. */
interface LoggedMemory {
  id: string
  level: number
  content: string
  tokens: number
  created: number
  /** The seq range the mint replaced, or undefined if the mint recorded none. */
  range?: { firstSeq: number; lastSeq: number }
}

/**
 * Write the scratch store's contents for one session log.
 *
 * Run before `ContextManager.open`: the message slot has to exist before the
 * manager tries to register it, and the strategy's slots before it loads them.
 *
 * Returns the two indexes the engine reasons with afterwards: the store message
 * id behind every replayed log seq, and the log seq range each seeded
 * recollection covers.
 */
export function seedFromLog(store: LogStore, session: Session): {
  readonly seqOf: Map<string, number>
  readonly known: Map<string, RecollectionRange>
} {
  const ids = slots()
  store.registerState(ids.messages)
  store.registerState(ids.summaries)
  store.registerState(ids.counter)

  const seqOf = new Map<string, number>()
  const idAtSeq = new Map<number, string>()
  for (const event of session.events) {
    if (!isAppendSurfaceEvent(event)) continue
    const message = session.deriveEventMessage(event)
    // A usage-only assistant step carries no message and so contributes no node.
    if (!message) continue
    const id = writeMessage(store, event, message, 'id', 'sequence')
    seqOf.set(id, event.seq)
    idAtSeq.set(event.seq, id)
  }

  // Sorted by log seq, so a recollection's `sourceIds` come out in store
  // position order and `sourceRange` can bound them — which is what
  // `recallCurveLeafIds` checks before it will treat an entry as a leaf.
  const surface = [...idAtSeq].sort((a, b) => a[0] - b[0])

  const known = new Map<string, RecollectionRange>()
  let counter = 0

  for (const memory of readMemoryLog(session)) {
    const legacy = legacyRange(session, memory.id)
    const range = memory.range ?? legacy?.range
    if (range === undefined) continue
    const { firstSeq, lastSeq } = range
    // A minted range is recorded by the mint itself, so the node that landed it is
    // the only one that could have: no reader needed.
    const landedAt = legacy?.at

    // Message ids when nothing has folded the ground, and the ids still on the
    // surface when something has — an L1 above a fold is not a leaf the recall
    // curve can walk. Child recollections when the ground is summaries.
    const covered = memory.level === 1
      ? slice(surface, firstSeq, lastSeq).map(([, id]) => id)
      : [...known]
        .filter(([, child]) => child.at !== undefined && child.at >= firstSeq && child.at <= lastSeq)
        .map(([id]) => id)

    // Skipped, not stubbed: an entry citing ground that does not exist would have
    // no sources to resolve and no range to cover, and `recallCurveLeafIds`
    // rejects it anyway (its `sourceRange` could not bound its `sourceIds`).
    // A non-empty list always has both bounds, so these two stand in for it.
    const first = covered.at(0)
    const last = covered.at(-1)
    // A recollection naming nothing is left out of `known` as well as out of the
    // store: an entry with no sources would have no covered span, and the planner
    // reads that span to decide what ground is already spoken for.
    if (first === undefined || last === undefined) continue

    // Two spans, because a recollection needs both and they are not the same one.
    // `covered` is the ground it stands over, which is what the planner has to
    // compare a surface node against. `cited` is the interval its fold node named,
    // and `at` is where that node landed. A higher recollection finds its children
    // by `at`: it cites the child nodes it shadows, so membership is a question
    // about nodes. Measured against the red-lemma log, which has 27 landed level-2
    // recollections, that reading places children under 23 of them and adopts 117,
    // where nesting on the cited intervals places 18 and adopts 55.
    // Both bounds resolve — every id in `covered` came out of `surface`.
    const coveredSeq = { firstSeq: seqOf.get(first) as number, lastSeq: seqOf.get(last) as number }

    store.appendToStateJson(ids.summaries.id, {
      id: memory.id,
      level: memory.level,
      content: memory.content,
      tokens: memory.tokens,
      sourceLevel: memory.level - 1,
      sourceIds: covered,
      sourceRange: { first, last },
      created: memory.created,
    } satisfies SummaryEntry)

    known.set(memory.id, { covered: coveredSeq, cited: { firstSeq, lastSeq }, ...(landedAt === undefined ? {} : { at: landedAt }) })
    counter = Math.max(counter, Number(/-(\d+)$/.exec(memory.id)?.[1] ?? -1) + 1)
  }

  store.setStateJson(ids.counter.id, counter)
  return { seqOf, known }
}

/**
 * A recollection minted after seeding records message ids, not log seqs, so its
 * range is resolved through the messages it names.
 */
export function resolveRange(seqOf: ReadonlyMap<string, number>, summary: SummaryEntry): { firstSeq: number; lastSeq: number } | undefined {
  const known = summary.sourceIds.flatMap(id => seqOf.get(id)).filter(seq => seq !== undefined)
  if (known.length === 0) return undefined
  return { firstSeq: Math.min(...known), lastSeq: Math.max(...known) }
}

/**
 * Append a surface node's derived message during a live session, returning the
 * store's id for it, or undefined when the event contributes no message.
 *
 * Both paths write through the store directly rather than through
 * `ContextManager.addMessage`, for two reasons. Only the store's own id
 * injection reproduces the ids a replay produces, and `seqOf` is keyed on them.
 * And `addMessage` shards a message over twice `targetChunkTokens`, a decision
 * replay cannot reconstruct from the log — so live and replayed would cut a
 * large body into different records. The engine has no stake in which
 * granularity wins (`rebuildChunks` never splits a message, so the whole body
 * lands in one chunk either way), only in the two agreeing.
 */
export function appendSurfaceNode(store: LogStore, session: Session, event: SessionEvent): string | undefined {
  const message = session.deriveEventMessage(event)
  // A usage-only assistant step carries no message and so contributes no node.
  if (!message) return undefined
  return writeMessage(store, event, message, 'id', 'sequence')
}

/**
 * One log event as a stored message.
 *
 * The harness message has no participant name of its own, and roles are what the
 * library's tool-message normalization reads, so the participant is the role
 * itself. `dshSeq` keeps the originating log seq on the row, which is how a
 * stored message is traced back to the event it came from.
 */
function writeMessage(
  store: LogStore,
  event: SessionEvent,
  message: { role: string; content: unknown },
  idField: string,
  sequenceField: string,
): string {
  return store.appendToStateJsonWithIdentity(
    slots().messages.id,
    {
      participant: message.role,
      content: message.content,
      metadata: { dshSeq: event.seq },
      timestamp: new Date(event.time),
    },
    idField,
    sequenceField,
  ).id
}

/**
 * The replayed messages a log seq range spans. Replay is in seq order, so the
 * survivors inside a minted range are one contiguous run and the bounds are
 * exact rather than a filter.
 */
function slice(surface: ReadonlyArray<readonly [number, string]>, firstSeq: number, lastSeq: number): Array<readonly [number, string]> {
  const from = surface.findIndex(([seq]) => seq >= firstSeq)
  if (from === -1) return []
  const to = surface.findLastIndex(([seq]) => seq <= lastSeq)
  return surface.slice(from, to + 1)
}

/**
 * The range of a recollection minted before the log recorded one.
 *
 * The pre-rewrite engine stamped no `sourceRange` on its `autobio/memory`
 * events, so the only surviving record of what a fold took is the fold node's
 * own `sourceEventSeqs`. Naming the node is the whole difficulty, and it takes
 * two readers because the identity moved: a node the old engine landed carries
 * no `compactionId` in its source and is named only by the `[Recall id]` header
 * in its text, while a node this engine lands carries the id in
 * `source.compactionId` and needs no prose. Unlanded mints are dropped: nothing
 * in the log says what ground they stood for.
 */
function legacyRange(session: Session, id: string): { range: { firstSeq: number; lastSeq: number }; at: number } | undefined {
  for (const event of session.events) {
    if (!isReplacementSurfaceEvent(event)) continue
    // A node that names an id in its source is read only there: the prose is a
    // fallback for nodes that name nothing, never a second opinion.
    if ((foldIdOf(event) ?? recallHeaderId(event)) !== id) continue
    // A replacement always cites every node it shadowed, so there is always a
    // list here to bound: the session refuses a replace that names no ground.
    const sources = event.sourceEventSeqs ?? []
    return { range: { firstSeq: Math.min(...sources), lastSeq: Math.max(...sources) }, at: event.seq }
  }
  return undefined
}

/** The recollection a pre-rewrite fold node names in its text, if it names one. */
function recallHeaderId(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  for (const block of event.data.message.content) {
    if (block.type !== 'text') continue
    const id = RECALL_HEADER.exec(block.text)?.[1]
    if (id !== undefined) return id
  }
  return undefined
}

const LEVEL_PREFIX = /^L(\d+)-/

/**
 * The header a fold node's text leads with, as {@link foldBlocks} writes it. The
 * id is matched without whitespace or a closing bracket so a recollection the
 * body happens to mention cannot be mistaken for the one the node stands for —
 * this reader only ever runs as the fallback for a node that names no id of its
 * own.
 */
const RECALL_HEADER = /^\[Recall ([^\]\s]+)\]/

/**
 * The recollections one log records, keyed by id and deduplicated, in mint order.
 * Level comes from the recorded level with the `L<n>-` id prefix as fallback, and
 * coverage from the mint event's own stamp — the log holds no other record of
 * which surface a mint replaced.
 *
 * Duplicate ids are dropped rather than merged: a pre-rewrite log can hold
 * several mints of one recollection id, and the first is the one whose recorded
 * range matches the content kept.
 *
 * Exported for the replay tests: a mint's level is a property of the event, and
 * asserting it here keeps the case from being entangled with how the store
 * happens to index a summary.
 */
export function readMemoryLog(session: Session): LoggedMemory[] {
  const memories = new Map<string, LoggedMemory>()
  for (const event of session.events) {
    if (event.type !== 'autobio/memory') continue
    const mint = event.data.memory
    if (!mint || memories.has(mint.id)) continue
    memories.set(mint.id, {
      id: mint.id,
      level: mint.level || Number(LEVEL_PREFIX.exec(mint.id)?.[1] ?? 1),
      content: mint.content,
      tokens: mint.tokens,
      created: mint.created,
      ...mint.sourceRange === undefined ? {} : { range: mint.sourceRange },
    })
  }
  return [...memories.values()]
}
