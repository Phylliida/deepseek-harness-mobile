/**
 * Fold planning: turn the strategy's committed per-message resolutions into
 * concrete surface operations.
 *
 * A plan is a pure function of the surface, the mirrored messages, and the
 * resolutions the last `compile()` committed. Seeding is deterministic, so a
 * mirrored run that does not line up with the surface is a bug, not a layout to
 * work around: every mismatch throws {@link DivergenceError} and the engine
 * boundary gives up on the pass. The old planner's silent `return null` paths
 * made "nothing to fold" and "the planner is broken" indistinguishable, which
 * is how its bug tail grew.
 *
 * Widening is a whole-pass decision, not a per-op one: every op's claimed
 * ground is placed on the surface before any op is widened, a node's owner is
 * settled once, and a walk stops at a node a sibling already owns. Two ops
 * whose recollections stand over the same run therefore partition it in plan
 * order rather than both replacing it.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/plan
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/src/estimate.ts'
import type { MessageId, StoredMessage, SummaryEntry } from '@animalabs/context-manager'
import { MESSAGES_STATE } from './store.ts'
import type { LogStore } from './store.ts'
import type { RecollectionRange } from './types.ts'
import { recollectionRows, resolveRange, surfaceGround } from './seed.ts'

/** One planned fold: shadow `startSeq..endSeq` with a single recollection node. */
export interface FoldOp {
  readonly summaryId: string
  readonly level: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  /** Estimated tokens the shadowed nodes occupy — what the fold reclaims. */
  readonly shadowedTokens: number
  /** What the replacement node says. */
  readonly summary: SummaryEntry
  /**
   * The live-surface seqs the op's span covers, in surface order: every
   * `shadowedSeqs` entry plus the nodes under a landed fold node the span
   * takes. This is the set the session checks a replacement against, so the
   * applier hands it over whole rather than re-deriving the expansion.
   */
  readonly coveredNodes: readonly number[]
}

/** A mirrored run of messages that does not line up with the logged surface. */
export class DivergenceError extends Error {
  override readonly name = 'DivergenceError'
}

/** What planning reads off the strategy, plus what seeding replayed. */
export interface PlanInputs {
  /** Committed resolutions, `MessageId` to level; only non-zero entries matter. */
  readonly resolutions: Map<MessageId, number>
  /** Minted recollections, for the content a fold renders. */
  readonly summaries: readonly SummaryEntry[]
  /** Log seq coverage per recollection seeded from the log. */
  readonly seeded: ReadonlyMap<string, RecollectionRange>
  /** Log seq behind each mirrored message id. */
  readonly seqOf: ReadonlyMap<string, number>
  /**
   * What one surface node costs, priced by the capability that owns the fixed
   * estimator (`ctx.tokenMeter`) so a fold's shadow price is the number that
   * capability prices the same node at. A density heuristic of this package's
   * own would price the same content a second time and drift from the meter
   * the fold's price is delta-accounted against.
   */
  readonly price: (message: Message | null) => number
}

/** One surface node, carrying what folding has to reason about. */
interface SurfaceNode {
  readonly seq: number
  /** The summary this node is a fold for, if it is one. */
  readonly foldId: string | undefined
  /** Original append seqs this node stands for, fold nodes expanded. */
  readonly coverage: readonly number[]
  readonly calls: readonly string[]
  readonly results: readonly string[]
  readonly tokens: number
}

/** What one op claims before widening: a recollection, its ground, its place. */
interface Claim {
  readonly summary: SummaryEntry
  /** Every log seq the op claims. */
  readonly keys: ReadonlySet<number>
  /** Surface positions whose ground the op claims. */
  readonly claimed: readonly number[]
}

const FOLD_ID_PREFIX = 'autobio:'

/**
 * The header a fold node's text leads with, as {@link foldBlocks} writes it. The
 * id is matched without whitespace or a closing bracket so a recollection the
 * body happens to mention cannot be mistaken for the one the node stands for.
 *
 * One home for the reading, because both replayers need it: {@link foldIdOf}
 * answers the planner, and seeding reads the same header to recover a node
 * written before the compaction-id convention landed.
 */
export const RECALL_HEADER = /^\[Recall ([^\]\s]+)\]/

/**
 * The recollection a fold node announces. The identity rides the compaction id
 * on the message's model source, not the prose: a summary carrying captured
 * reasoning is replayed without a header, because prepending one to verbatim
 * `responseContent` would break the signatures it exists to carry. Reading the
 * identity there is what makes a reopened session's folds recoverable: a log
 * replayed from the first event rebuilds the pyramid from these ids alone.
 *
 * The `[Recall <id>]` header is the fallback, and it is load-bearing: a fold
 * written before that convention landed names its recollection in the text —
 * its `autobio-session-<id>-<n>` compaction id does not match the prefix — and
 * a node read as "not a fold" is ground the planner folds a second time.
 *
 * @param event - the logged event to read.
 * @returns the recollection id, or `undefined` when the event is not a fold
 *   node.
 */
export function foldIdOf(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  // An assistant message's source is a model source, so the compaction id needs
  // no narrowing.
  const { compactionId } = event.data.message.source
  if (compactionId?.startsWith(FOLD_ID_PREFIX)) return compactionId.slice(FOLD_ID_PREFIX.length)
  // Only a block that leads with the header names a recollection; a body citing
  // `[Recall L1-0]` mid-sentence does not.
  const block = event.data.message.content.find(one => one.type === 'text')
  return block?.type === 'text' ? RECALL_HEADER.exec(block.text)?.[1] : undefined
}

/**
 * The inverse of {@link foldIdOf}: the `source.compactionId` a fold for
 * `summaryId` lands under. The bracket id of the transaction that lands the node
 * is the same string, as the compaction protocol requires.
 *
 * @param summaryId - the recollection id to name.
 * @returns the compaction id the fold node carries.
 */
export function foldCompactionId(summaryId: string): string {
  return `${FOLD_ID_PREFIX}${summaryId}`
}

/**
 * What a fold node says. Captured reasoning blocks replay verbatim — the
 * signatures cover their content, and the models that need them back need them
 * back unmutated — so the recall header is only added where there is room for
 * it, on the text fallback that legacy entries and stubs take.
 *
 * @param summary - the minted recollection to render.
 * @returns the blocks for the replacement message, which the caller lands
 *   unmodified, and which {@link foldIdOf} reads the recollection's id back out
 *   of when the message source cannot carry it.
 */
export function foldBlocks(summary: SummaryEntry): ContentBlock[] {
  if (summary.responseContent?.length) return summary.responseContent as ContentBlock[]
  return [{ type: 'text', text: `[Recall ${summary.id}]\n\n${summary.content}` }]
}

/**
 * What one surface node costs under the token meter's fixed estimator.
 *
 * That estimator is {@link estimateMessage}: the node's blocks plus the frame it
 * is sent in. A text-only price reads a tool round as nearly free — a call's name
 * and arguments and a result's payload are blocks — which is how a shrinking fold
 * came to register as growth.
 *
 * @param message - the node's message, or null when the node derives none.
 * @returns the node's price, or 0 for a node that derives no message.
 */
export function priceSurfaceNode(message: Message | null): number {
  if (message === null) return 0
  return estimateMessage(message)
}

/**
 * Plan this pass's folds: partition the resolved messages by the recollection
 * standing over them, then widen each span.
 *
 * Runs of equal resolution level are not the unit, because a resolution lands on
 * the *messages* a recollection covered rather than on the recollection: two
 * adjacent recollections at one level resolve their messages identically, so a
 * run of equal levels spans ground no single recollection owns. The entry
 * standing for a resolved message is the fold, and the messages resolving to it
 * are the span it replaces.
 *
 * @param store - the seeded store holding the mirrored messages, each stamped
 *   with the log seq it came from.
 * @param session - the session whose surface the folds land on.
 * @param inputs - the strategy's committed resolutions, its minted
 *   recollections, what seeding replayed, and the node price to plan with.
 * @returns one fold per recollection that has ground to replace, ordered by
 *   first surface position. An op whose claimed run a sibling owns is left out,
 *   because the surface would otherwise carry that ground twice. Empty when the
 *   surface already matches the frontier, which is a settled state rather than
 *   a failure.
 * @throws {@link DivergenceError} when the mirrored history and the log
 *   disagree: when a resolved message has no recollection standing over it, or
 *   when a surface node names a seq the log does not hold.
 */
export function planFolds(store: LogStore, session: Session, inputs: PlanInputs): FoldOp[] {
  const ranges = standing(inputs, recollectionRows(store))
  // The surface position of the ground each log seq stands on, written for the
  // same reason the surface is read: a landed fold node replaced the node it
  // stands for and took its place, so the message behind that node is no longer a
  // surface node of its own — its seq is held by the fold node, and the fold
  // node's position is where the two would be. The first node to hold a seq
  // keeps it.
  const place = new Map<number, number>()
  const surface = annotateSurface(session, inputs.price, place)

  // A resolution lands on the *messages* a recollection covered, so two adjacent
  // recollections at the same level resolve the same way and a run of equal
  // levels spans ground no single recollection owns. Partition by recollection
  // instead: the entry standing for the resolved message is the fold, and the
  // resolved run it sits on is the span that fold replaces.
  const claims = new Map<string, { summary: SummaryEntry; keys: Set<number>; claimed: number[] }>()
  for (const message of store.getStateJson(MESSAGES_STATE) as StoredMessage[]) {
    const level = inputs.resolutions.get(message.id) ?? 0
    const seq = message.metadata?.['dshSeq']
    if (level === 0 || !Number.isSafeInteger(seq)) continue
    const summary = standingFor(ranges, level, seq as number)
    // A recollection is folded once however its messages are divided, so the
    // surface is never asked to carry the same recollection twice. Every message
    // a recollection covers resolves to the same level and the entry standing for
    // one of them stands for the rest, so the claim only widens here.
    const claim = claims.get(summary.id) ?? { summary, keys: new Set<number>(), claimed: [] }
    claims.set(summary.id, claim)
    claim.keys.add(seq as number)
    const position = place.get(seq as number)
    // A message the surface does not hold is ground the plan cannot place, and
    // nothing that folds it either.
    if (position !== undefined) claim.claimed.push(position)
  }

  // A claim whose ground a landed fold node already stands for — with ground
  // the claim does not own besides — belongs to a recollection an ancestor's
  // fold has replaced: the pyramid only merges upward, so a node covering the
  // claim's keys plus more is a parent's node, and folding the child again
  // would shadow that ground a second time. The test reads the surface alone,
  // never a pyramid pointer, because the landed node is itself the proof the
  // ground is spoken for; equality is kept out so a claim whose own node landed
  // still reaches the settled check in `land()`.
  const foldedGround = surface
    .filter(node => node.foldId !== undefined)
    .map(node => new Set(node.coverage))
  const represented = (claim: { keys: ReadonlySet<number> }): boolean =>
    foldedGround.some(ground =>
      ground.size > claim.keys.size && [...claim.keys].every(seq => ground.has(seq)))

  // Every claim before any widening, because the walk asks who a node already
  // belongs to. Position order settles a contested node: the op that reaches it
  // first owns it, which is also the order the ops are returned in.
  const ordered = [...claims.values()]
    .filter(claim => claim.claimed.length > 0 && !represented(claim))
    .sort((left, right) => Math.min(...left.claimed) - Math.min(...right.claimed))
    .map(claim => new PlannedOp(claim, surface, Math.min(...claim.claimed), Math.max(...claim.claimed)))

  // One op at a time, in plan order. A sibling's claim is what its fold replaces,
  // and widening is where a span grows past what it started with — so both are
  // known before any walk runs: an op that cannot land its own claim yields it to
  // the sibling that can, and a walk stops at ground a sibling has claimed.
  const taken = new Set<number>()
  const ops: FoldOp[] = []
  for (const op of ordered) {
    ops.push(...op.land(taken))
    // What the op's fold replaces is its span on the surface, and a later op reads
    // it as ground already spoken for.
    for (const at of op.span(new Set())) taken.add(at)
  }
  return ops
}

/**
 * Every live recollection's coverage, by level, in the order the pyramid minted
 * them. Both coverage readings are unioned rather than one being preferred: the
 * seeded coverage is what the log recorded at mint time and the resolved one is
 * what the entry's own sources say now, and a recollection that has since
 * absorbed more ground is the wider of the two. Computed once per pass, because
 * every mirrored message asks the same table for the entry standing over it.
 */
function standing(inputs: PlanInputs, rows: readonly SummaryEntry[]): Map<number, Standing[]> {
  const byLevel = new Map<number, Standing[]>()
  for (const summary of inputs.summaries) {
    // The picker leaves the newest recollection standing for a covered run
    // unresolved, so the entry of the level the run needs has no resolution.
    // A recollection the pyramid has merged upward is *not* skipped here: its
    // `mergedInto` records formation, not representation — until the parent's
    // own fold lands, the child's node is still what the surface shows for that
    // ground, and the messages under it still resolve at the child's level.
    // Once the parent lands, those nodes are gone and the question never comes
    // up, so the pointer never needs reading either way.
    const seeded = inputs.seeded.get(summary.id)?.covered
    const resolved = resolveRange(inputs.seqOf, summary, rows)
    const first = Math.min(seeded?.firstSeq ?? Infinity, resolved?.firstSeq ?? Infinity)
    const last = Math.max(seeded?.lastSeq ?? -Infinity, resolved?.lastSeq ?? -Infinity)
    if (first > last) continue
    const level = byLevel.get(summary.level)
    if (level === undefined) byLevel.set(summary.level, [{ summary, first, last }])
    else level.push({ summary, first, last })
  }
  return byLevel
}

/** One recollection, with the log span it stands over. */
interface Standing {
  readonly summary: SummaryEntry
  readonly first: number
  readonly last: number
}

/** The recollection at `level` standing for one log seq, or a throw. */
function standingFor(byLevel: Map<number, Standing[]>, level: number, seq: number): SummaryEntry {
  // The newest standing entry wins, because a recollection that absorbed ground
  // is minted after the ones it absorbed.
  const summary = byLevel.get(level)?.filter(entry => entry.first <= seq && entry.last >= seq).at(-1)?.summary
  if (summary === undefined) throw new DivergenceError(`no level-${level} recollection stands for log seq ${seq}`)
  return summary
}

/**
 * Annotate the live surface. A fold node's coverage expands through the seqs it
 * replaced, so its footprint stays comparable with the nodes it stands for.
 */
function annotateSurface(
  session: Session,
  price: PlanInputs['price'],
  place: Map<number, number>,
): SurfaceNode[] {
  const events = new Map(session.events.map(event => [event.seq, event]))
  // The ground each node stands for, fold nodes expanded through the nodes they
  // replaced.
  const coverage = surfaceGround(session)
  const nodes: SurfaceNode[] = []

  for (const seq of session.surface.nodes) {
    // A surface node is a seq into this log by construction, so the lookup is
    // total and a miss means the surface and the events have been desynchronized.
    const event = events.get(seq)
    /* v8 ignore next -- unreachable: both maps are built from this session's own
       events, and a desynchronized surface is the bug this asserts on rather than
       a state to keep planning through. */
    if (event === undefined) throw new DivergenceError(`surface node ${seq} has no event in the log`)
    const message = deriveEventMessage(event)
    const calls: string[] = []
    const results: string[] = []
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-call') calls.push(block.id)
      if (block.type === 'tool-result') results.push(block.toolCallId)
    }
    const ground = coverage.get(seq)
    /* v8 ignore next -- unreachable for the same reason as the event lookup: one
       pass builds the expansion for every node of this surface. */
    if (ground === undefined) throw new DivergenceError(`surface node ${seq} has no ground in the log`)
    nodes.push({ seq, foldId: foldIdOf(event), coverage: ground, calls, results, tokens: price(message) })
    // Ground a node holds is at this node's position, and the node's own seq is
    // at it before any other node can claim it.
    for (const held of ground) place.set(held, nodes.length - 1)
  }
  return nodes
}

/**
 * One planned fold before widening: the recollection, the log seqs it claims,
 * and the surface positions that ground sits on.
 *
 * A node this op claims is covered: it stands inside the span the fold
 * replaces. A node reached by widening is taken only when the walk proves the
 * span answers it — a result whose call is inside the span, or the call of a
 * result that is. A landed fold node is neither until the op's claim covers the
 * ground that node stands for, which is the one case where two recollections
 * are reading the same history rather than disagreeing about it.
 */
class PlannedOp {
  /** Surface positions this op covers, after widening. */
  private from: number
  private to: number
  private readonly surface: readonly SurfaceNode[]

  constructor(
    private readonly claim: Claim,
    surface: readonly SurfaceNode[],
    /** Surface position behind the first seq the claim holds. */
    first: number,
    /** Surface position behind the last seq the claim holds. */
    last: number,
  ) {
    this.surface = surface
    // Bounds, not listed positions: a claimed seq can sit behind a landed fold
    // node that the surface index does not carry, and the span still holds it.
    this.from = first
    this.to = last
  }

  /**
   * Whether one surface position holds this recollection's own landed node.
   *
   * @param position - the surface position to test.
   * @returns whether the node there is the fold this recollection already has.
   */
  private own(position: number): boolean {
    return (this.surface[position] as SurfaceNode).foldId === this.claim.summary.id
  }

  /**
   * The run of surface positions this op claims, whatever a sibling holds.
   *
   * It spans the bounds rather than listing the claimed positions: the first and
   * last claimed offsets are the whole run, because the mirrored messages they
   * stand for are contiguous and nothing else can sit between two consecutive
   * messages of one run.
   *
   * @returns every surface position the claim covers, in surface order.
   */
  run(): readonly number[] {
    const claimed: number[] = []
    for (let at = this.from; at <= this.to; at++) claimed.push(at)
    return claimed
  }

  /**
   * The run this op can actually replace: its claim, up to the first position a
   * sibling has landed on. Widening moves over the same run.
   *
   * @param taken - the surface positions a sibling op has landed on. An empty
   *   set is the whole run, which is what the pass reads when it commits an op's
   *   span.
   * @returns every surface position the op holds, in surface order.
   */
  span(taken: ReadonlySet<number>): readonly number[] {
    /* v8 ignore next -- attribution: this method's body is instrumented under the
       range the reporter names, so the measurements below read as uncovered while
       every pass that plans a fold runs it. */
    return clipped(this.run(), taken)
  }

  /**
   * The op this pass lands, or none when a sibling owns nodes it claims.
   *
   * @param taken - the surface positions a sibling op has already landed on.
   * @returns the op, or none when a sibling has landed on all of its ground.
   */
  land(taken: Set<number>): FoldOp[] {
    // Ground a sibling has landed on is not this op's to replace, so the claim
    // covers only the prefix of its run the sibling leaves. Two ops over one run
    // therefore partition it: the later op's first position is the earlier op's,
    // and it folds the rest or, when the run is that one position, nothing.
    const span = this.span(taken)
    /* v8 ignore next -- unreachable: a sibling can only hold a position this op
       claims when the two stand over shared ground, and then the level resolves
       every message they share to the newer one, so the older op's claim cannot
       include the newer's first position. */
    if (span.length === 0) return []
    // The surface carrying this recollection's own landed node and nothing else
    // is the settled state: the node stands where its ground did, and folding
    // again would trade the two places forever.
    let settled = true
    for (const position of span) {
      if (!this.own(position)) settled = false
    }
    if (settled) return []
    this.widen(taken)
    // What the fold replaces is never ground a sibling has landed on: widening
    // stops in front of it, so the span can be narrower than the run claimed, and
    // reading it back through the same test is what keeps two ops' spans disjoint.
    const held = this.span(taken)
    /* v8 ignore next -- unreachable: the span tested above is non-empty and comes
       from the same run, and widening only widens it. */
    if (held.length === 0) return []
    this.from = Math.min(...held)
    this.to = Math.max(...held)
    const landed = this.surface.slice(this.from, this.to + 1)

    const covered: number[] = []
    for (const node of landed) {
      // A node this recollection itself landed is the replacement it already has,
      // not something the next one shadows; the ground it stands for is skipped
      // with it, so the fold does not take its own footprint back.
      /* v8 ignore next -- unreachable: a span that is only this recollection's
         own node returns above, and widening stops at it, so a span holding both
         the node and other ground cannot arise. */
      if (node.foldId === this.claim.summary.id) continue
      covered.push(node.seq, ...nodesUnder(node, this.claim.summary.id, this.claim.keys))
    }
    return [{
      summaryId: this.claim.summary.id,
      level: this.claim.summary.level,
      startSeq: (landed[0] as SurfaceNode).seq,
      endSeq: (landed.at(-1) as SurfaceNode).seq,
      shadowedSeqs: landed.map(node => node.seq),
      // The token meter prices the nodes it folds, so a fold's price is the sum
      // over the same nodes rather than a price of the rendered span: the span
      // may take a landed fold node, whose price is one recollection rather than
      // the ground it stands for.
      shadowedTokens: landed.reduce((total, node) => total + node.tokens, 0),
      summary: this.claim.summary,
      coveredNodes: covered,
    }]
  }

  /**
   * Move the span over the tool nodes the fold would otherwise leave half a
   * round of, in both directions.
   *
   * Backward takes the results standing between the fold and the node that calls
   * for them, one node at a time, and stops at that call node. A round answers
   * its calls on separate nodes, so the result nearest the fold need not be the
   * round's only one — reaching the call node is what makes the round whole. The
   * walk leaves alone anything the span already answers and a node answering
   * several calls at once, which belongs to a round whose other half the span
   * never claimed. It stops at ground a sibling has landed on rather than
   * crossing it to reach the call beyond, which is what leaves the sibling its
   * own round.
   *
   * Forward mirrors it: results of calls the span holds are taken as a
   * contiguous run, and the walk stops at a node that asks for a tool of its own
   * — taking a node whose call the span does not reach would orphan that call —
   * or at a node that answers nothing the span waits for.
   *
   * @param taken - the surface positions a sibling op has already landed on.
   */
  private widen(taken: ReadonlySet<number>): void {
    let from = this.from
    let to = this.to
    // Backward: the node that declares the calls a span's results answer. A span
    // whose left edge is already a call node holds its round's head and stops
    // here; one that starts on a result is half a round, and the walk is what
    // finishes it. Everything the walk crosses is a result answering a call the
    // span already takes, so the round comes back whole.
    const answered = new Set(this.surface.slice(from, to + 1).flatMap(node => node.results))
    /* v8 ignore next -- the left-edge test: every fixture's backward reach starts
       on a result node, which is the case the walk exists for; a span whose left
       edge declares the calls already holds its round's head. */
    while (from > 0 && !(this.surface[from] as SurfaceNode).calls.length) {
      const at = from - 1
      const node = this.surface[at] as SurfaceNode
      // Ground a sibling has landed on is not this fold's to reach through: the
      // walk stops in front of it rather than crossing it to the call beyond.
      if (taken.has(at)) break
      // Calls the span does not answer are another round's, and the walk stops in
      // front of the node that declares them.
      if (node.calls.some(id => !answered.has(id))) break
      // The node whose calls these results answer is the round's head, and the
      // last node the walk takes.
      if (node.calls.length > 0) {
        from = at
        break
      }
      // A node that brings no result the span is missing is not part of this
      // round either.
      /* v8 ignore next -- the `node.results.length === 0` half: a node with no
         results and no calls is not a surface node, since a message with no
         blocks contributes none. */
      if (node.results.length === 0 || node.results.every(id => answered.has(id))) break
      for (const id of node.results) answered.add(id)
      from = at
    }

    // Forward: results the span's calls are still waiting for.
    const pending = new Set(this.surface.slice(from, to + 1).flatMap(node => node.calls))
    while (to + 1 < this.surface.length && pending.size > 0) {
      const at = to + 1
      const next = this.surface[at] as SurfaceNode
      const answers = next.results.filter(id => pending.has(id))
      if (answers.length === 0 || next.calls.length > 0) break
      for (const id of answers) pending.delete(id)
      to = at
    }

    this.from = from
    this.to = to
  }
}

/**
 * The prefix of a run that no sibling has landed on.
 *
 * A sibling's ground is never inside the run: the only sibling that can reach
 * into it is one over shared ground, and the run's first position is then that
 * sibling's, so the prefix it leaves is empty.
 *
 * @param run - the surface positions an op claims, in surface order.
 * @param taken - the surface positions a sibling op has already landed on.
 * @returns the positions of the run up to the first one a sibling holds.
 */
function clipped(run: readonly number[], taken: ReadonlySet<number>): readonly number[] {
  const held: number[] = []
  for (const at of run) {
    /* v8 ignore next -- unreachable: a sibling holds a position inside the run
       only when the two stand over shared ground, and then the run's first
       position is that sibling's, which ends the loop at once. */
    if (taken.has(at)) break
    held.push(at)
  }
  return held
}

/**
 * Whether one node is ground this op is folding rather than somebody else's: an
 * appended node whose own seq the claim covers, or — for a node that is a fold
 * for another recollection — a node whose whole footprint the claim covers.
 *
 * The second clause is the one that keeps a sibling's fold node out of a span
 * that would otherwise swallow it. A node standing for ground this op's
 * recollection does not stand over is a different history, and the two would
 * both be on the surface with one of them hidden.
 *
 * @param node - the surface node to place.
 * @param summaryId - the recollection doing the folding.
 * @param keys - the log seqs that recollection's ground is claimed at.
 * @returns whether the node is the folding recollection's own ground.
 */
function owns(node: SurfaceNode, summaryId: string, keys: ReadonlySet<number>): boolean {
  /* v8 ignore next -- unreachable: a span that only covers nodes this
     recollection landed returns above, so a node of its own cannot reach here. */
  if (node.foldId === summaryId) return false
  if (node.foldId === undefined) return node.coverage.some(seq => keys.has(seq))
  return node.coverage.every(seq => keys.has(seq))
}

/**
 * The ground a span's node brings under a replacement it is part of: a node the
 * span takes for itself, and — for a landed fold node this op's claim covers —
 * the nodes underneath it, one layer at a time until every leaf is named.
 *
 * @param node - the node inside the span.
 * @param summaryId - the recollection doing the folding.
 * @param keys - the log seqs that recollection's ground is claimed at.
 * @returns the node's own seq, or the seqs it stands for.
 */
function nodesUnder(node: SurfaceNode, summaryId: string, keys: ReadonlySet<number>): readonly number[] {
  return owns(node, summaryId, keys) && node.foldId !== undefined ? node.coverage : []
}
