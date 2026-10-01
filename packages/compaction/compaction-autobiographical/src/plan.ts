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

import { deriveEventMessage, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MessageId, StoredMessage, SummaryEntry } from '@animalabs/context-manager'
import { MESSAGES_STATE } from './store.ts'
import type { LogStore } from './store.ts'
import type { RecollectionRange } from './types.ts'
import { estimateTokens } from './types.ts'
import { resolveRange } from './seed.ts'

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
   * Where the span sits on the surface. Sequencing alone cannot say: a landed
   * fold node takes the position of the ground it replaced, so the surface is
   * ordered by log seq except where it is not.
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
 * `responseContent` would break the signatures it exists to carry.
 */
export function foldIdOf(event: SessionEvent): string | undefined {
  const source = event.type === 'assistant/message' ? event.data.message.source : undefined
  const compactionId = source?.kind === 'model' ? source.compactionId : undefined
  return compactionId?.startsWith(FOLD_ID_PREFIX) ? compactionId.slice(FOLD_ID_PREFIX.length) : undefined
}

/** The compaction id a fold for `summaryId` lands under. */
export function foldCompactionId(summaryId: string): string {
  return `${FOLD_ID_PREFIX}${summaryId}`
}

/**
 * What a fold node says. Captured reasoning blocks replay verbatim — the
 * signatures cover their bytes, and the models that need them back need them
 * back unmutated — so the recall header is only added where there is room for
 * it, on the text fallback that legacy entries and stubs take.
 */
export function foldBlocks(summary: SummaryEntry): ContentBlock[] {
  if (summary.responseContent?.length) return summary.responseContent as ContentBlock[]
  return [{ type: 'text', text: `[Recall ${summary.id}]\n\n${summary.content}` }]
}

/**
 * Plan this pass's folds. Empty when the surface already matches the frontier.
 * @throws DivergenceError when the mirrored history and the log disagree.
 */
export function planFolds(store: LogStore, session: Session, inputs: PlanInputs): FoldOp[] {
  // A resolution lands on the *messages* a recollection covered, so two adjacent
  // recollections at the same level resolve the same way and a run of equal
  // levels spans ground no single recollection owns. Partition by recollection
  // instead: the entry standing for the resolved message is the fold, and the
  // resolved run it sits on is the span that fold replaces.
  const claimed = new Map<string, { summary: SummaryEntry; first: number; last: number }>()
  for (const message of store.getStateJson(MESSAGES_STATE) as StoredMessage[]) {
    const level = inputs.resolutions.get(message.id) ?? 0
    if (level === 0) continue
    const seq = message.metadata?.['dshSeq']
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) continue
    // The picker leaves the newest recollection standing for a covered run
    // unresolved, so the entry of the level the run needs has no resolution.
    // A recollection the pyramid has already merged upward is superseded, so it
    // is not the one standing. Both pointers are checked because the library
    // writes `mergedInto` (deprecated) on the live path and reads `parentId` as
    // the alias, so a store mid-migration can carry either.
    const summary = inputs.summaries
      .filter(entry =>
        entry.level === level
        && entry.parentId === undefined
        && entry.mergedInto === undefined
        && standsOver(inputs, entry, seq))
      .at(-1)
    if (summary === undefined) {
      throw new DivergenceError(`no level-${level} recollection stands for log seq ${seq}`)
    }
    // A recollection is folded once however its messages are divided, so the
    // surface is never asked to carry the same recollection twice. Every message
    // a recollection covers resolves to the same level and the entry standing for
    // one of them stands for the rest, so the coverage only widens here.
    const seen = claimed.get(summary.id)
    if (seen === undefined) claimed.set(summary.id, { summary, first: seq, last: seq })
    else {
      seen.first = Math.min(seen.first, seq)
      seen.last = Math.max(seen.last, seq)
    }
  }

  const surface = annotateSurface(session)
  const ops: FoldOp[] = []

  for (const { summary, first, last } of claimed.values()) {
    // A landed fold node standing for other ground is this fold's to replace
    // like any message — the replacement subsumes it. The recollection's own
    // landed node is not, or the surface would carry it twice. The endpoints
    // ride along with the walk, so the span cannot disagree with what it covers.
    const shadowed: number[] = []
    let tokens = 0
    let from: number | undefined
    let to: number | undefined
    surface.forEach((node, at) => {
      if (node.foldId === summary.id) return
      if (!node.coverage.some(seq => seq >= first && seq <= last)) return
      shadowed.push(node.seq)
      tokens += node.tokens
      from ??= at
      to = at
    })

    if (from === undefined) continue
    ops.push({
      summaryId: summary.id,
      level: summary.level,
      startSeq: surface[from]?.seq ?? 0,
      endSeq: surface[to ?? from]?.seq ?? 0,
      shadowedSeqs: shadowed,
      shadowedTokens: tokens,
      summary,
      span: { from, to: to ?? from },
    })
  }

  return widen(ops, surface)
}

/** Whether a recollection's coverage takes in one log seq. */
function standsOver(inputs: PlanInputs, summary: SummaryEntry, seq: number): boolean {
  const range = rangeOf(inputs, summary)
  return range !== undefined && range.firstSeq <= seq && range.lastSeq >= seq
}

/**
 * The log seqs a recollection stands for. Both readings are kept and unioned
 * rather than one being preferred: the seeded coverage is what the log recorded
 * at mint time, the resolved one is what the entry's own sources say now, and a
 * recollection that has since absorbed more ground is the wider of the two.
 */
function rangeOf(inputs: PlanInputs, summary: SummaryEntry): { firstSeq: number; lastSeq: number } | undefined {
  const seeded = inputs.seeded.get(summary.id)?.covered
  const resolved = resolveRange(inputs.seqOf, summary)
  if (seeded === undefined) return resolved
  if (resolved === undefined) return seeded
  return {
    firstSeq: Math.min(seeded.firstSeq, resolved.firstSeq),
    lastSeq: Math.max(seeded.lastSeq, resolved.lastSeq),
  }
}

/**
 * Annotate the live surface. A fold node's coverage expands through the seqs it
 * replaced, so its footprint stays comparable with the nodes it stands for.
 */
function annotateSurface(session: Session): SurfaceNode[] {
  const events = new Map(session.events.map(event => [event.seq, event]))
  const cache = new Map<number, readonly number[]>()

  const coverageOf = (seq: number, seen: Set<number>): readonly number[] => {
    const cached = cache.get(seq)
    if (cached !== undefined) return cached
    if (seen.has(seq)) return [seq]
    seen.add(seq)
    const event = events.get(seq)
    const sources = event && isReplacementSurfaceEvent(event) ? event.sourceEventSeqs : undefined
    const coverage = sources?.length ? sources.flatMap(source => coverageOf(source, seen)) : [seq]
    cache.set(seq, coverage)
    return coverage
  }

  return session.surface.nodes.map((seq) => {
    const event = events.get(seq)
    const calls: string[] = []
    const results: string[] = []
    let text = ''
    for (const block of (event && deriveEventMessage(event)?.content) || []) {
      if (block.type === 'tool-call') calls.push(block.id)
      if (block.type === 'tool-result') results.push(block.toolCallId)
      if (block.type === 'text') text += block.text
    }
    return {
      seq,
      foldId: event === undefined ? undefined : foldIdOf(event),
      coverage: coverageOf(seq, new Set()),
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
 */
function widen(ops: FoldOp[], surface: SurfaceNode[]): FoldOp[] {
  // Surface positions of the nodes earlier ops claimed. One node belongs to one
  // fold, and ops arrive in plan order, so the first fold to reach a node keeps
  // it and a later one treats it as a boundary.
  const taken = new Set<number>()

  return ops.map((op) => {
    const { from: start, to: end } = op.span
    let from = start
    let to = end

    // Backward: an assistant node just before the fold whose calls the fold
    // answers is half a round the fold would break. It declares calls only, so
    // one node of reach is all there is.
    const before = surface[start - 1]
    if (before !== undefined && !taken.has(start - 1)) {
      const answered = new Set(surface.slice(start, end + 1).flatMap(node => node.results))
      if (before.calls.some(id => answered.has(id))) from = start - 1
    }

    // Forward: results the fold leaves standing, taken as one contiguous run so
    // that a round stays whole.
    const inside = new Set(surface.slice(from, to + 1).flatMap(node => node.results))
    const pending = new Set(surface.slice(from, to + 1).flatMap(node => node.calls).filter(id => !inside.has(id)))
    while (to + 1 < surface.length && pending.size > 0 && !taken.has(to + 1)) {
      const next = surface[to + 1] as SurfaceNode
      const answers = next.results.filter(id => pending.has(id))
      if (answers.length === 0 || next.calls.length > 0) break
      for (const id of answers) pending.delete(id)
      to++
    }

    const widened = surface.slice(from, to + 1)
    widened.forEach((_, offset) => taken.add(from + offset))
    if (from === start && to === end) return op
    const head = surface[from]
    const tail = surface[to]
    if (head === undefined || tail === undefined) return op
    return {
      ...op,
      startSeq: head.seq,
      endSeq: tail.seq,
      shadowedSeqs: widened.map(node => node.seq),
      shadowedTokens: widened.reduce((total, node) => total + node.tokens, 0),
      span: { from, to },
    }
  })
}
