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
 *    recollection cannot be derived (minting calls a model), so the event payload
 *    *is* the archive: content, level, and the seq range it covered. Replay also
 *    rebuilds the pyramid's links: each entry names the recollections it stands over,
 *    and every one of those is stamped with the parent that took it, which is what a
 *    later open reads to tell its frontier from what the pyramid already consolidated.
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
  const folds = foldNodes(session)
  const children = new Map<string, string[]>()
  const logged = readMemoryLog(session)

  for (const memory of logged) {
    const landed = folds.get(memory.id)
    const range = memory.range ?? landed?.covered
    if (range === undefined) continue
    const { firstSeq, lastSeq } = range
    // Two spans, because a recollection needs both and they are not the same one.
    // `range` is what the entry says it stood for: a mint's own stamp, which is the
    // union of the ground its children stand over, or the ground a legacy fold took.
    // `cited` is the envelope its node named, which is where its children's nodes sit;
    // an unlanded mint cites nothing and its range is the whole of it.
    const cited = landed?.cited ?? range

    // Message ids when nothing has folded the ground, and the ids still on the surface
    // when something has — an L1 above a fold is not a leaf the recall curve can walk.
    // Every level above names recollections, and the ones it names are the outermost
    // inside its interval.
    const sources = memory.level === 1
      ? slice(surface, firstSeq, lastSeq).map(([, id]) => id)
      : childrenOf([...known].filter(([, child]) => child.covered.firstSeq >= firstSeq && child.covered.lastSeq <= lastSeq))

    // Skipped, not stubbed: an entry citing ground that does not exist would have no
    // sources to resolve and no range to cover, and `recallCurveLeafIds` rejects it
    // anyway (its `sourceRange` could not bound its `sourceIds`). A non-empty list
    // always has both bounds, so these two stand in for it. A recollection naming
    // nothing is left out of `known` as well: an entry with no sources would have no
    // covered span, and the planner reads that span to decide what ground is spoken for.
    const first = sources.at(0)
    const last = sources.at(-1)
    if (first === undefined || last === undefined) continue

    // The messages the sources bottom out in, which is what `sourceRange` holds:
    // upstream stamps a merge with the leaves under its first and last source, and
    // `recallCurveLeafIds` reads a range naming anything else as an entry with no
    // walkable leaves. A source that is a message is its own leaf, and one naming a
    // recollection is that recollection's leaves, so both bounds resolve: every source
    // is a message id out of `surface` or an id `known` already holds.
    const leaves = sources.flatMap(id => leavesOf(id, known))
    const leafFirst = leaves.at(0) as string
    const leafLast = leaves.at(-1) as string

    // The ground it stands over, which is what the planner compares a surface node
    // against and what the recollection above it finds it inside. The log seqs its
    // leaves came from — that is the reading a source naming a recollection cannot give,
    // since a recollection is a pyramid entry rather than a mirrored message.
    const ground = {
      firstSeq: seqOf.get(leafFirst) as number,
      lastSeq: seqOf.get(leafLast) as number,
    }

    store.appendToStateJson(ids.summaries.id, {
      id: memory.id,
      level: memory.level,
      content: memory.content,
      tokens: memory.tokens,
      sourceLevel: memory.level - 1,
      sourceIds: sources,
      sourceRange: { first: leafFirst, last: leafLast },
      created: memory.created,
    } satisfies SummaryEntry)

    for (const child of sources) {
      const parented = children.get(child)
      if (parented === undefined) children.set(child, [memory.id])
      else parented.push(memory.id)
    }
    known.set(memory.id, {
      covered: ground,
      cited,
      leaves,
      ...(landed === undefined ? {} : { at: landed.at }),
    })
  }

  // A merged child is what makes its parent the entry standing over that ground:
  // the library reads the pointer (`getSummaryParentId`) to decide what is left to
  // consolidate, and reads `mergedInto` directly on the merge ladder. Left unset, a
  // seeded pyramid looks like an unmerged backlog and opening it repopulates the
  // merge queue over children it already merged — one compression call per reopen.
  // The deepest parent is the one that stands, because a parent minted after a
  // child absorbed it is the node the pyramid narrowed to.
  for (const [child, parents] of children) {
    const rows = store.getStateJson(ids.summaries.id) as SummaryEntry[]
    const at = rows.findIndex(entry => entry.id === child)
    /* v8 ignore next -- unreachable: a child is named by an entry this loop wrote
       into the slot, and nothing between the two writes removes one. */
    if (at < 0) continue
    store.editStateItem(
      ids.summaries.id,
      at,
      Buffer.from(JSON.stringify({ ...rows[at] as SummaryEntry, mergedInto: parents.at(-1) as string })),
    )
  }

  // One past the highest index the log holds, whether or not that recollection
  // reached the store: one seeding drops still owns its id, and a run that reissued
  // it would write two mints under the same name.
  store.setStateJson(ids.counter.id, 1 + logged.reduce(
    (highest, memory) => Math.max(highest, Number(/-(\d+)$/.exec(memory.id)?.[1] ?? -1)),
    -1,
  ))
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
 *
 * Expanded once per seq and remembered, because the same nodes are reached again
 * from every fold above them.
 */
function groundOf(
  events: ReadonlyMap<number, SessionEvent>,
  seq: number,
  expanded: Map<number, readonly number[]>,
): readonly number[] {
  const remembered = expanded.get(seq)
  /* v8 ignore next -- the memo hit: a seq reached twice in one walk is what the map
     is for, and it answers with what the expansion below would recompute. */
  if (remembered !== undefined) return remembered
  const event = events.get(seq)
  const sources = event !== undefined && isReplacementSurfaceEvent(event) ? event.sourceEventSeqs : undefined
  const ground = sources?.length
    ? sources.flatMap(source => groundOf(events, source, expanded))
    : [seq]
  expanded.set(seq, ground)
  return ground
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
  const expanded = new Map<number, readonly number[]>()
  for (const seq of session.surface.nodes) coverage.set(seq, groundOf(events, seq, expanded))
  return coverage
}

/** Where one fold node landed, and the ground it took. */
interface FoldNode {
  readonly covered: { readonly firstSeq: number; readonly lastSeq: number }
  readonly cited: { readonly firstSeq: number; readonly lastSeq: number }
  /** Log seq of the node itself. */
  readonly at: number
}

/**
 * Every fold node in the log, by the recollection it names. Read once per replay
 * because each recollection asks for its own node and each answer is a scan of the
 * whole log otherwise.
 *
 * The node is named the way {@link foldIdOf} reads it: by the `compactionId` its
 * message source carries, or — for a node written before that convention landed,
 * whose `autobio-session-<id>-<n>` id matches no prefix — by the `[Recall <id>]`
 * header in its text. The first node to answer for an id wins, because a
 * recollection is landed once.
 *
 * `covered` is the ground the fold took, which is what the planner compares a
 * surface node against. It is the cited seqs *expanded* the way {@link groundOf}
 * expands any node: a pre-rewrite node cites the child fold nodes it shadows as readily
 * as it cites raw events, and reading those citations as seqs reports the interval the
 * parent named rather than the ground it took — the two are not the same interval, and
 * `L2-6` on the red-lemma log cites `6709..54199` for ground of `249..49115`. `cited` is
 * that unexpanded envelope, and it is the one the entry reports as the interval it named.
 */
function foldNodes(session: Session): Map<string, FoldNode> {
  const folds = new Map<string, FoldNode>()
  const events = new Map(session.events.map(event => [event.seq, event]))
  const expanded = new Map<number, readonly number[]>()
  for (const event of session.events) {
    if (!isReplacementSurfaceEvent(event)) continue
    const id = foldIdOf(event)
    if (id === undefined || folds.has(id)) continue
    // A replacement cites every node it shadowed or it does not land, so the list
    // to bound is always here: the session refuses a replace that names no ground.
    const sources = event.sourceEventSeqs as number[]
    const ground = sources.flatMap(seq => groundOf(events, seq, expanded))
    folds.set(id, {
      covered: { firstSeq: Math.min(...ground), lastSeq: Math.max(...ground) },
      cited: { firstSeq: Math.min(...sources), lastSeq: Math.max(...sources) },
      at: event.seq,
    })
  }
  return folds
}

/**
 * The recollections one recollection of recollections stands over.
 *
 * These are the outermost of the recollections inside it: an intermediate one carries
 * its own children's ground, so it is the layer the level above consolidated, and the
 * ones beneath it stay its own. Measured against the red-lemma log, which has 27
 * landed level-2 recollections, that reading places children under 23 of them and
 * adopts 117, where reading the interval a landed fold cites places 18 and adopts 55.
 *
 * Order is the pyramid's own, so the ids come out in the order the leaves they stand
 * over were laid down — `recallCurveLeafIds` reads a parent's leaves as the
 * concatenation of its children's, and a child out of place puts its leaves out of
 * order there.
 *
 * @param inside - the recollections whose ground falls inside the interval being read,
 * oldest first.
 * @returns the ids of the layer, as the parent cites them.
 */
function childrenOf(inside: ReadonlyArray<readonly [string, RecollectionRange]>): string[] {
  const layer: Array<readonly [string, RecollectionRange]> = []
  for (const [id, child] of inside) {
    const nested = layer.some(([, kept]) => again(kept.covered, child.covered))
    /* v8 ignore next -- the `if` branch: both outcomes are ordinary, and the one that
       pushes is the common case a log of layers is made of. */
    if (!nested) layer.push([id, child])
  }
  return layer.map(([id]) => id)
}

/**
 * Whether one recollection's ground holds another's, the two being distinct entries.
 *
 * Equal spans count as neither: a recollection whose ground is exactly its child's stands
 * over that child, which is what a fold whose node cited only the one child it reached
 * leaves behind, and both are layers of the interval above them — the ground one takes
 * is not what separates one layer from the next.
 *
 * @param outer - the ground of the recollection already in the layer.
 * @param inner - the ground of the recollection being placed.
 * @returns whether `inner` sits strictly inside `outer`.
 */
function again(outer: { firstSeq: number; lastSeq: number }, inner: { firstSeq: number; lastSeq: number }): boolean {
  /* v8 ignore next 4 -- the second bound and the `lastSeq` disjunct: a candidate whose
     ground starts inside the parent's always ends inside it too, because a span is the
     union of the spans beneath it. Equal spans are the legacy fold that re-took one child
     whole, and they reach the disjunct's left half. */
  return inner.firstSeq >= outer.firstSeq
    && inner.lastSeq <= outer.lastSeq
    && (inner.firstSeq > outer.firstSeq || inner.lastSeq < outer.lastSeq)
}

/**
 * The message ids one source bottoms out in.
 *
 * A message is its own leaf; a recollection's are its own sources', which is how
 * `recallCurveLeafIds` expands it. Every source seeding writes is one or the other,
 * so the empty answer is for an archive that has drifted out from under the log.
 */
function leavesOf(id: string, known: ReadonlyMap<string, RecollectionRange>): readonly string[] {
  return known.get(id)?.leaves ?? [id]
}

const LEVEL_PREFIX = /^L(\d+)-/

/**
 * The recollections one log records, keyed by id and deduplicated, in mint order.
 * Level comes from the recorded level with the `L<n>-` id prefix as fallback, and
 * coverage from the mint event's own stamp — the log holds no other record of
 * which surface a mint replaced.
 *
 * One record per id: a pre-rewrite log can hold several mints of one recollection,
 * and the copy that carries a range is the one whose content seeding can place. A
 * later range-less mint never displaces an earlier ranged one, and a ranged mint
 * replaces a range-less one of the same id — the reverse order would leave the
 * ground of a recollection the log does state uncited, and seeding drops what it
 * cannot place.
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
    if (!mint) continue
    if (mint.sourceRange === undefined && memories.get(mint.id)?.range !== undefined) continue
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
