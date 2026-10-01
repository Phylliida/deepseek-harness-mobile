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
 * The surface is pair-safe by induction — calls live on assistant nodes and
 * results on `tool/result` nodes, never on one node — so widening only has to
 * look at a fold's immediate neighbours, and cannot chain.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/plan
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MessageId, StoredMessage, SummaryEntry } from '@animalabs/context-manager'
import { MESSAGES_STATE } from './store.ts'
import type { LogStore } from './store.ts'
import type { RecollectionRange } from './types.ts'
import { estimateTokens } from './types.ts'
import { resolveRange, surfaceGround } from './seed.ts'

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
   * Where the span sits on the surface, as positions into it. Log seqs cannot
   * say: a landed fold node takes the position of the ground it replaced, so the
   * surface is ordered by seq except where it is not. Internal to the walk —
   * {@link FoldOp} is what the caller gets, and widening consumes this.
   */
  readonly span: { readonly from: number; readonly to: number }
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

const FOLD_ID_PREFIX = 'autobio:'

/**
 * The recollection a fold node announces. The identity rides the compaction id
 * on the message's model source, not the prose: a summary carrying captured
 * reasoning is replayed without a header, because prepending one to verbatim
 * `responseContent` would break the signatures it exists to carry. Reading the
 * identity there is what makes a reopened session's folds recoverable: a log
 * replayed from the first event rebuilds the pyramid from these ids alone.
 *
 * @param event - the logged event to read.
 * @returns the recollection id with its prefix removed, or `undefined` when the
 *   event is not a fold node.
 */
export function foldIdOf(event: SessionEvent): string | undefined {
  const source = event.type === 'assistant/message' ? event.data.message.source : undefined
  const compactionId = source?.kind === 'model' ? source.compactionId : undefined
  return compactionId?.startsWith(FOLD_ID_PREFIX) ? compactionId.slice(FOLD_ID_PREFIX.length) : undefined
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
 *   unmodified.
 */
export function foldBlocks(summary: SummaryEntry): ContentBlock[] {
  if (summary.responseContent?.length) return summary.responseContent as ContentBlock[]
  return [{ type: 'text', text: `[Recall ${summary.id}]\n\n${summary.content}` }]
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
 * Widening takes a tool call together with its result and cannot chain, since
 * calls live on assistant nodes and results on `tool/result` nodes, never on one
 * node.
 *
 * @param store - the seeded store holding the mirrored messages, each stamped
 *   with the log seq it came from.
 * @param session - the session whose surface the folds land on.
 * @param inputs - the strategy's committed resolutions, its minted
 *   recollections, and what seeding replayed.
 * @returns one fold per recollection that has ground to replace, ordered by
 *   first surface position. Empty when the surface already matches the frontier,
 *   which is a settled state rather than a failure.
 * @throws {@link DivergenceError} when the mirrored history and the log
 *   disagree: when a resolved message has no recollection standing over it, or
 *   when a surface node names a seq the log does not hold.
 */
export function planFolds(store: LogStore, session: Session, inputs: PlanInputs): FoldOp[] {
  const ranges = standing(inputs)
  // A resolution lands on the *messages* a recollection covered, so two adjacent
  // recollections at the same level resolve the same way and a run of equal
  // levels spans ground no single recollection owns. Partition by recollection
  // instead: the entry standing for the resolved message is the fold, and the
  // resolved run it sits on is the span that fold replaces.
  const claimed = new Map<string, { summary: SummaryEntry; first: number; last: number }>()
  for (const message of store.getStateJson(MESSAGES_STATE) as StoredMessage[]) {
    const level = inputs.resolutions.get(message.id) ?? 0
    const seq = message.metadata?.['dshSeq']
    if (level === 0 || !Number.isSafeInteger(seq)) continue
    const summary = standingFor(ranges, level, seq as number)
    // A recollection is folded once however its messages are divided, so the
    // surface is never asked to carry the same recollection twice. Every message
    // a recollection covers resolves to the same level and the entry standing for
    // one of them stands for the rest, so the coverage only widens here.
    const claimedSo = claimed.get(summary.id)
    if (claimedSo === undefined) claimed.set(summary.id, { summary, first: seq as number, last: seq as number })
    else {
      claimedSo.first = Math.min(claimedSo.first, seq as number)
      claimedSo.last = Math.max(claimedSo.last, seq as number)
    }
  }

  const surface = annotateSurface(session)
  const ops: FoldOp[] = []

  for (const { summary, first, last } of claimed.values()) {
    // A landed fold node standing for other ground is this fold's to replace
    // like any message — the replacement subsumes it. The recollection's own
    // landed node is not, or the surface would carry it twice. Nodes covered are
    // contiguous, because the mirrored messages they stand for are and nothing
    // else can sit between two consecutive messages of one run, so the first and
    // last offsets are the whole span.
    const covers = (node: SurfaceNode): boolean =>
      node.foldId !== summary.id && node.coverage.some(seq => seq >= first && seq <= last)
    const from = surface.findIndex(covers)
    if (from < 0) continue
    let to = from
    let tokens = 0
    for (let at = from; at < surface.length; at++) {
      const node = surface[at] as SurfaceNode
      if (!covers(node)) break
      to = at
      tokens += node.tokens
    }
    ops.push({
      summaryId: summary.id,
      level: summary.level,
      // Both offsets exist: `from` is a `findIndex` hit and `to` only ever moves
      // inside the surface.
      startSeq: (surface[from] as SurfaceNode).seq,
      endSeq: (surface[to] as SurfaceNode).seq,
      shadowedSeqs: surface.slice(from, to + 1).map(node => node.seq),
      shadowedTokens: tokens,
      summary,
      span: { from, to },
    })
  }

  return widen(ops, surface)
}

/**
 * Every live recollection's coverage, by level, in the order the pyramid minted
 * them. Both coverage readings are unioned rather than one being preferred: the
 * seeded coverage is what the log recorded at mint time and the resolved one is
 * what the entry's own sources say now, and a recollection that has since
 * absorbed more ground is the wider of the two. Computed once per pass, because
 * every mirrored message asks the same table for the entry standing over it.
 */
function standing(inputs: PlanInputs): Map<number, { summary: SummaryEntry; first: number; last: number }[]> {
  const byLevel = new Map<number, { summary: SummaryEntry; first: number; last: number }[]>()
  for (const summary of inputs.summaries) {
    // The picker leaves the newest recollection standing for a covered run
    // unresolved, so the entry of the level the run needs has no resolution. A
    // recollection the pyramid has merged upward is superseded, so it is not the
    // one standing. Both pointers are checked because the library writes
    // `mergedInto` (deprecated) on the live path and reads `parentId` as the
    // alias, so a store mid-migration can carry either.
    /* oxlint-disable typescript/no-deprecated -- the alias this read exists for */
    if (summary.parentId !== undefined || summary.mergedInto !== undefined) continue
    /* oxlint-enable typescript/no-deprecated */
    const seeded = inputs.seeded.get(summary.id)?.covered
    const resolved = resolveRange(inputs.seqOf, summary)
    const first = Math.min(seeded?.firstSeq ?? Infinity, resolved?.firstSeq ?? Infinity)
    const last = Math.max(seeded?.lastSeq ?? -Infinity, resolved?.lastSeq ?? -Infinity)
    if (first > last) continue
    const level = byLevel.get(summary.level)
    if (level === undefined) byLevel.set(summary.level, [{ summary, first, last }])
    else level.push({ summary, first, last })
  }
  return byLevel
}

/** The recollection at `level` standing for one log seq, or a throw. */
function standingFor(
  byLevel: Map<number, { summary: SummaryEntry; first: number; last: number }[]>,
  level: number,
  seq: number,
): SummaryEntry {
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
function annotateSurface(session: Session): SurfaceNode[] {
  const events = new Map(session.events.map(event => [event.seq, event]))
  const coverage = surfaceGround(session)

  return session.surface.nodes.map((seq) => {
    // A surface node is a seq into this log by construction, so the lookup is
    // total and a miss means the surface and the events have been desynchronized.
    const event = events.get(seq)
    /* v8 ignore next -- unreachable: both maps are built from this session's own
       events, and a desynchronized surface is the bug this asserts on rather than
       a state to keep planning through. */
    if (event === undefined) throw new DivergenceError(`surface node ${seq} has no event in the log`)
    const calls: string[] = []
    const results: string[] = []
    let text = ''
    for (const block of deriveEventMessage(event)?.content ?? []) {
      if (block.type === 'tool-call') calls.push(block.id)
      if (block.type === 'tool-result') results.push(block.toolCallId)
      if (block.type === 'text') text += block.text
    }
    return {
      seq,
      foldId: foldIdOf(event),
      coverage: coverage.get(seq) as readonly number[],
      calls,
      results,
      tokens: estimateTokens(text),
    }
  })
}

/**
 * Widen each fold over the tool nodes it would otherwise orphan. Visibility is
 * judged against the final layout — a node is visible after this pass iff no
 * fold shadows it — which is what lets sibling folds cooperate.
 *
 * Widening needs no record of what earlier ops claimed: one node answers to one
 * recollection, so the spans the walk produced are already disjoint, and a node
 * a sibling owns is not inside this range for {@link planFolds} to have taken.
 */
function widen(ops: FoldOp[], surface: SurfaceNode[]): FoldOp[] {
  return ops.map((op) => {
    const { from: start, to: end } = op.span
    let from = start
    let to = end

    // Backward: an assistant node just before the fold whose calls the fold
    // answers is half a round the fold would break. It declares calls only, so
    // one node of reach is all there is.
    const covered = surface.slice(start, end + 1)
    const results = new Set(covered.flatMap(node => node.results))
    const before = surface[start - 1]
    if (before !== undefined && before.calls.some(id => results.has(id))) from = start - 1

    // Forward: results the fold leaves standing, taken as one contiguous run so
    // that a round stays whole.
    const pending = new Set(
      surface.slice(from, to + 1).flatMap(node => node.calls).filter(id => !results.has(id)),
    )
    while (to + 1 < surface.length && pending.size > 0) {
      const next = surface[to + 1] as SurfaceNode
      const answers = next.results.filter(id => pending.has(id))
      if (answers.length === 0 || next.calls.length > 0) break
      for (const id of answers) pending.delete(id)
      to++
    }

    const widened = surface.slice(from, to + 1)
    if (from === start && to === end) return op
    return {
      ...op,
      startSeq: (surface[from] as SurfaceNode).seq,
      endSeq: (surface[to] as SurfaceNode).seq,
      shadowedSeqs: widened.map(node => node.seq),
      shadowedTokens: widened.reduce((total, node) => total + node.tokens, 0),
      span: { from, to },
    }
  })
}
