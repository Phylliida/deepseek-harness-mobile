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
 * Both passes store the library's block vocabulary rather than the harness's,
 * because the library reads its own names only — see {@link toMembraneBlock}.
 *
 * The chunks slot stays empty on purpose. `AutobiographicalStrategy` synthesizes
 * chunk records from L1 `sourceIds` whenever it finds L1s and no chunks
 * (`migrateChunkRecords`), then `rebuildChunks` spreads them over the live
 * messages — so re-deriving them here would duplicate a migration the library
 * already performs.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/seed
 */

import type { ContextManager, MessageId, SummaryEntry } from '@animalabs/context-manager'
import type { ContentBlock as MembraneBlock } from '@animalabs/membrane'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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
 *
 * @param store - the empty scratch store to write into. Its message, summary and
 * counter slots are registered here, so a store that already carries them is
 * refused rather than written to twice.
 * @param session - the session whose log is the archive. Only append events are
 * replayed and no replacement is mirrored, so the store holds the originals a
 * previous run folded rather than the folds themselves.
 * @returns `seqOf`, the log seq behind each store message id; and `known`, each
 * seeded recollection's covered and cited ranges, and the seq its fold node
 * landed on when the log records one. Both are keyed for the engine's own reads
 * and neither is written back to the store.
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
    const content = mirrorContent(message)
    if (content === undefined) continue
    const id = writeMessage(store, event, message.role, content)
    seqOf.set(id, event.seq)
    idAtSeq.set(event.seq, id)
  }

  // Sorted by log seq, so a recollection's `sourceIds` come out in store
  // position order and `sourceRange` can bound them — which is what
  // `recallCurveLeafIds` checks before it will treat an entry as a leaf.
  const surface = [...idAtSeq].sort((a, b) => a[0] - b[0])

  const known = new Map<string, RecollectionRange>()
  const coverage = surfaceGround(session)
  let counter = 0

  for (const memory of readMemoryLog(session)) {
    const legacy = legacyRange(session, coverage, memory.id)
    const range = memory.range ?? legacy?.covered
    if (range === undefined) continue
    const { firstSeq, lastSeq } = range
    // A minted range is recorded by the mint itself, so the node that landed it is
    // the only one that could have: no reader needed.
    const landedAt = legacy?.at
    // The interval a child's node has to fall inside. For a minted range that is
    // the range itself; for a legacy fold it is the envelope its node cited, which
    // is where its children's nodes sit — the expanded ground starts at the events
    // underneath them.
    const widened = legacy?.cited ?? range

    // Message ids when nothing has folded the ground, and the ids still on the
    // surface when something has — an L1 above a fold is not a leaf the recall
    // curve can walk. Child recollections when the ground is summaries.
    const covered = memory.level === 1
      ? slice(surface, firstSeq, lastSeq).map(([, id]) => id)
      : [...known]
        .filter(([, child]) => child.at !== undefined && child.at >= widened.firstSeq && child.at <= widened.lastSeq)
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

    known.set(memory.id, { covered: coveredSeq, cited: widened, ...(landedAt === undefined ? {} : { at: landedAt }) })
    counter = Math.max(counter, Number(/-(\d+)$/.exec(memory.id)?.[1] ?? -1) + 1)
  }

  store.setStateJson(ids.counter.id, counter)
  return { seqOf, known }
}

/**
 * The recollection rows seeding wrote, which a range read walks a chain of
 * higher recollections through.
 *
 * @param store - the seeded store holding the summaries slot.
 * @returns the rows, or none when the engine is reading a store it did not seed.
 */
export function recollectionRows(store: LogStore): readonly SummaryEntry[] {
  // The slot holds an array once `seedFromLog` registers it, which is the only
  // way this store is opened, so there is no absent case to answer for here.
  return store.getStateJson(slots().summaries.id) as readonly SummaryEntry[]
}

/**
 * A recollection minted after seeding records store ids rather than log seqs, so
 * its range is resolved through what its sources name.
 *
 * A level-1 recollection names the messages it distilled, and those are in
 * `seqOf`; a higher one names the recollections beneath it — `sourceIds` is
 * "message IDs for L1, summary IDs for L_{k>1}" — which `seqOf` does not hold and
 * never will, since a recollection is a pyramid entry rather than a mirrored
 * message. So a chain is walked through the seeded summaries, and a recollection
 * spans the union of what its own sources resolve to.
 *
 * A source that resolves to nothing contributes no seq rather than failing the
 * read: that is ground a later fold removed, or a citation the log does not
 * account for.
 *
 * @param seqOf - the log seq behind each store message id, as
 * {@link seedFromLog} returns it.
 * @param summary - the recollection whose sources the range is read from.
 * @param summaries - the recollection rows seeding wrote, which a chain of higher
 * recollections is walked through. Absent when the caller holds only the message
 * map, in which case a recollection naming recollections resolves to nothing.
 * @returns the first and last log seq its sources span, or undefined when none of
 * them resolves. The undefined case is a refusal rather than an empty span:
 * `Math.min()` over no arguments is `Infinity`, so a caller that read the bounds
 * anyway would record a range no seq can fall inside.
 */
export function resolveRange(
  seqOf: ReadonlyMap<string, number>,
  summary: SummaryEntry,
  summaries?: readonly SummaryEntry[],
): { firstSeq: number; lastSeq: number } | undefined {
  return new Ranges(seqOf, summaries).of(summary)
}

/** A recollection's covered span, in log-seq terms. */
type ResolvedRange = { firstSeq: number; lastSeq: number }

/**
 * Resolves recollections to the log span they cover by walking the chain above
 * each one. A recollection spans the union of what its own sources resolve to.
 */
class Ranges {
  private readonly byId: ReadonlyMap<string, SummaryEntry>

  constructor(
    private readonly seqOf: ReadonlyMap<string, number>,
    summaries: readonly SummaryEntry[] | undefined,
  ) {
    this.byId = new Map((summaries ?? []).map(entry => [entry.id, entry]))
  }

  /**
   * The span a recollection covers.
   * @param summary - the recollection to resolve.
   * @returns its span, or undefined when nothing beneath it resolves to a seq.
   */
  of(summary: SummaryEntry): ResolvedRange | undefined {
    return this.over(summary, new Set())
  }

  /**
   * The span one recollection covers, without revisiting its own chain.
   * @param summary - the recollection to resolve.
   * @param open - ids on the current walk, so a citation that loops back stops.
   * @returns its span, or undefined when nothing beneath it resolves to a seq.
   */
  private over(summary: SummaryEntry, open: ReadonlySet<string>): ResolvedRange | undefined {
    if (open.has(summary.id)) return undefined
    const below = new Set(open).add(summary.id)
    const seqs: number[] = []
    for (const id of summary.sourceIds) {
      const seq = this.seqOf.get(id)
      if (seq !== undefined) {
        seqs.push(seq)
        continue
      }
      const source = this.byId.get(id)
      if (source === undefined) continue
      const range = this.over(source, below)
      if (range !== undefined) seqs.push(range.firstSeq, range.lastSeq)
    }
    if (seqs.length === 0) return undefined
    return { firstSeq: Math.min(...seqs), lastSeq: Math.max(...seqs) }
  }
}

/**
 * Mirror one surface node the log gained, returning the store's id for it, or
 * undefined when the event contributes no message.
 *
 * The write goes through `ContextManager.addMessage` rather than straight to
 * the store, so the library's own bookkeeping sees the message: `addMessage`
 * bumps the write version `MessageStore` revalidates its id index against, and
 * fires `onNewMessage`, which rebuilds the strategy's chunks. A row written
 * straight to the slot leaves `manager.getMessage` blind to it and the strategy
 * chunking ground it never learned about. `autoTickOnNewMessage` stays off, so
 * that hook compresses nothing.
 *
 * The stored row is the one the seed path writes: the store assigns the
 * identity a replay would assign, and the log seq rides the metadata as
 * `dshSeq`, which is how a fold finds the event behind a message.
 *
 * Only append events reach this: a replacement is never mirrored, because the
 * planner finds the ground a fold node stands for already covered and asks for no
 * fold there.
 *
 * @param manager - the open manager whose store the node is appended to.
 * @param session - the session the event came from, read for the derived message.
 * @param event - the appended surface event to mirror.
 * @returns the store's own message id for the node, or undefined when the event
 * contributes nothing to mirror — a usage-only assistant step carries no message,
 * and a message carrying no blocks stands for no row. Both are real and expected
 * cases, not failures.
 */
export function appendSurfaceNode(manager: ContextManager, session: Session, event: SessionEvent): MessageId | undefined {
  const message = session.deriveEventMessage(event)
  // A usage-only assistant step carries no message and so contributes no node.
  if (!message) return undefined
  const content = mirrorContent(message)
  if (content === undefined) return undefined
  return manager.addMessage(message.role, content, { dshSeq: event.seq })
}

/**
 * One log event as a stored message.
 *
 * The harness message has no participant name of its own, and roles are what the
 * library's tool-message normalization reads, so the participant is the role
 * itself. The timestamp is the event's own clock in milliseconds, which is what
 * the library's time filters compare against and what `MessageStore` writes for
 * a live append.
 */
function writeMessage(
  store: LogStore,
  event: SessionEvent,
  participant: string,
  content: readonly MembraneBlock[],
): string {
  return store.appendToStateJsonWithIdentity(
    slots().messages.id,
    {
      participant,
      content,
      metadata: { dshSeq: event.seq },
      timestamp: event.time,
    },
    'id',
    'sequence',
  ).id
}

/**
 * The content one surface message contributes to the store, or undefined when it
 * contributes nothing.
 *
 * A message with no blocks stands for nothing the memory system can price, chunk
 * or remember: the library classifies such a row as empty content and requires no
 * rendering for it, so the store keeps only rows that carry something. The seed
 * and the live path both apply the rule, so a replay of the same log numbers the
 * same rows.
 *
 * The row is built fresh rather than handed the session's own blocks: the session
 * deep-freezes what it publishes, and the library treats the messages it
 * materializes from this slot as mutable.
 */
function mirrorContent(message: { readonly content: readonly ContentBlock[] }): MembraneBlock[] | undefined {
  return message.content.length === 0 ? undefined : message.content.map(toMembraneBlock)
}

/**
 * The harness's block vocabulary in the library's.
 *
 * The two name the same blocks differently, and the library reads its own names
 * only: under the harness's, a tool call prices at zero tokens, matches no
 * tool-pair check, and leaves its chunk looking tool-free to the strategy's
 * compression gate, so a tool transcript reaches memory formation as text with
 * its tools missing.
 *
 * A block the harness carries a durable reference for rather than a payload —
 * an image — becomes a placeholder: the store cannot represent the attachment,
 * and the fact of it is what a recollection can preserve.
 */
function toMembraneBlock(block: ContentBlock): MembraneBlock {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'thinking', thinking: block.text }
    case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: toolInput(block.arguments) }
    case 'tool-result':
      return {
        type: 'tool_result',
        toolUseId: block.toolCallId,
        // A result's content nests blocks of its own, and the library prices
        // and renders it by recursing into them.
        content: block.content.map(toMembraneBlock),
        ...block.isError === undefined ? {} : { isError: block.isError },
      }
    default: return { type: 'text', text: `[${block.type} omitted from memory mirror]` }
  }
}

/** Tool arguments as the library stores them; input that is not a JSON object keeps an empty record. */
function toolInput(arguments_: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(arguments_)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
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
 * The ground a replacement node took, by log seq — every cited node expanded
 * through the fold nodes it stands for, down to appended events.
 *
 * A citation is a node, and a node can be a fold's own replacement rather than
 * something appended: measured against the red-lemma log, 36 of its 160 fold
 * nodes cite an earlier fold's node. Reading those citations as seqs reports the
 * interval the parent *named* instead of the ground it took, and the two are not
 * the same interval — `L2-6` cites `6709..54199` while the ground it actually
 * stands over is `249..49115`, which is ground a child already owned.
 *
 * Self-citations cannot recurse, and the recursion needs no guard of its own: the
 * session refuses a citation that is not strictly earlier than the node citing it
 * (`sourceEventSeqs must reference earlier events`), so every expansion step
 * descends in seq and the walk terminates.
 */
function groundOf(events: ReadonlyMap<number, SessionEvent>, seq: number): readonly number[] {
  const event = events.get(seq)
  const sources = event !== undefined && isReplacementSurfaceEvent(event) ? event.sourceEventSeqs : undefined
  return sources?.length ? sources.flatMap(source => groundOf(events, source)) : [seq]
}

/**
 * Ground coverage per surface seq, memoized. Exported because the planner needs
 * the same expansion to keep a fold node's footprint comparable with the nodes it
 * stands for, and two implementations of it would drift.
 *
 * @param session - the session whose surface is expanded.
 * @returns every surface node's seq mapped to the log seqs it stands for: its own
 * seq for an appended event, and the appended events underneath it for a fold
 * node, however many levels of replacement were folded over them.
 */
export function surfaceGround(session: Session): Map<number, readonly number[]> {
  const events = new Map(session.events.map(event => [event.seq, event]))
  const coverage = new Map<number, readonly number[]>()
  for (const seq of session.surface.nodes) coverage.set(seq, groundOf(events, seq))
  return coverage
}

/**
 * The ranges of a recollection minted before the log recorded one.
 *
 * `covered` is the ground the fold took, which is what the planner compares a
 * surface node against. It is the cited seqs *expanded* through
 * {@link surfaceGround}: a pre-rewrite node cites the child fold nodes it shadows
 * as readily as it cites raw events, and reading those citations as seqs reports
 * the interval the parent named rather than the ground it took. The two are not
 * the same interval — `L2-6` cites `6709..54199` while the ground it stands over
 * is `249..49115`, which is ground its own child already owned.
 *
 * `cited` is that unexpanded envelope, and it is the one a higher recollection's
 * interval has to be measured against: a child is found by the seq its own node
 * landed on, and those nodes sit at the cited bounds. Collapsing the two loses
 * the children in exactly the fold-over-fold case that matters.
 *
 * The node is named by the `[Recall id]` header in its text: a pre-rewrite node
 * carries a `compactionId` of its own form (`autobio-session-<id>-<n>`, which
 * `foldIdOf` does not match — measured on the red-lemma log, all 160 fold nodes
 * name themselves the old way), so the header answers for the whole legacy set.
 * Unlanded mints are dropped: nothing in the log says what ground they stood
 * for.
 */
function legacyRange(
  session: Session,
  coverage: ReadonlyMap<number, readonly number[]>,
  id: string,
): { covered: { firstSeq: number; lastSeq: number }; cited: { firstSeq: number; lastSeq: number }; at: number } | undefined {
  for (const event of session.events) {
    if (!isReplacementSurfaceEvent(event)) continue
    // A node that names an id in its source is read only there: the prose is a
    // fallback for nodes that name nothing, never a second opinion.
    if ((foldIdOf(event) ?? recallHeaderId(event)) !== id) continue
    // A replacement cites every node it shadowed or it does not land, so the list
    // to bound is always here: the session refuses a replace that names no ground.
    const sources = event.sourceEventSeqs as number[]
    const ground = sources.flatMap(seq => coverage.get(seq) ?? [seq])
    return {
      covered: { firstSeq: Math.min(...ground), lastSeq: Math.max(...ground) },
      cited: { firstSeq: Math.min(...sources), lastSeq: Math.max(...sources) },
      at: event.seq,
    }
  }
  return undefined
}

/** The recollection a pre-rewrite fold node names in its text, if it names one. */
function recallHeaderId(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const texts = event.data.message.content.flatMap(block => (block.type === 'text' ? [block.text] : []))
  return texts.map(text => RECALL_HEADER.exec(text)?.[1]).find(id => id !== undefined)
}

const LEVEL_PREFIX = /^L(\d+)-/

/**
 * The header a fold node's text leads with, as {@link foldBlocks} writes it. The
 * id is matched without whitespace or a closing bracket so a recollection the
 * body happens to mention cannot be mistaken for the one the node stands for —
 * this reader only ever runs as the fallback for a node that names no id of its
 * own.
 *
 * Exported for the replay tests, which read the header a pre-rewrite log names
 * its folds with.
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
 *
 * @param session - the session whose log is read.
 * @returns the recollections the log records, one per distinct id, in mint order.
 * A mint whose event carries no range has none here, and seeding drops it rather
 * than stubbing one: nothing in the log then says what ground it stood for.
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
