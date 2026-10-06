/**
 * Landing folds: bracketed, metered compaction transactions.
 *
 * Deliberately dumb. Planning already widened each op to pair-safe boundaries
 * and settled which nodes it covers, so nothing here reasons about surface
 * layout — it proves the plan still fits the surface it is about to change, then
 * writes what it is given. That is the point of the split: the old applicator
 * decided layout while it applied, which is where its chaining, absorbed-node
 * bookkeeping and refusal paths came from.
 *
 * One fold per bracket, because the compaction protocol allows exactly one
 * `compaction/summary` between a `compaction/start` and its `compaction/end`
 * (`packages/compaction/compaction/src/invariant.ts`: `summarized` is set once and
 * a repeat fails). A pass that folds two regions therefore lands two
 * transactions — which is also what lets the bracket carry the fold's own
 * identity.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/apply
 */

import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { RequestContext, Session } from '@deepseek-ai/dsh-session'
import { DivergenceError, foldBlocks, foldCompactionId } from './plan.ts'
import type { FoldOp } from './plan.ts'

/**
 * Refuse a plan whose ops do not fit the surface they would land on, before any
 * of them opens a bracket.
 *
 * Every refusal has to happen here or not at all. A `compaction/start` that is
 * never closed strands the lock: the compaction invariant refuses the next
 * `compaction/start` and every turn boundary the open bracket crosses, so one
 * mis-planned fold wedges the session for good. The two things the session
 * itself would refuse mid-bracket are therefore checked up front — the surface
 * span each op declares, and the content it would carry, since the log accepts
 * lossless JSON only and this backend replays captured reasoning verbatim.
 *
 * A span is read the way the session reads it: both ends are live surface nodes,
 * and the op's citations cover every node between them. Citations are not
 * required to be live themselves — an op that takes a landed fold node cites the
 * ground under it too, which that node replaced and which is no longer a surface
 * node of its own, and a fold a merge produced is exactly that case.
 *
 * Spans must also be pairwise disjoint: a node two ops both replace is a node
 * whose replacement the second op can no longer name, and the surface protocol
 * refuses the range rather than land a second node for one position.
 *
 * @param session - the live session the ops would land in.
 * @param ops - the folds to land, in the order they would land.
 * @throws {@link DivergenceError} when an op's span does not name two live
 *   surface nodes in order, when an op leaves a node it spans uncited, when two
 *   ops overlap, or when an op's content is not storable.
 */
export function assertFoldOpsApply(session: Session, ops: readonly FoldOp[]): void {
  const nodes = session.surface.nodes
  for (const op of ops) {
    // The span is a surface-POSITION range, so a fold node carrying a late
    // replacement seq sits inside it: membership, not seq ordering, is what the
    // session resolves a replacement against.
    const start = nodes.indexOf(op.startSeq)
    const end = nodes.indexOf(op.endSeq)
    if (start === -1 || end === -1 || start > end) {
      throw new DivergenceError(
        `fold for ${op.summaryId} spans ${op.startSeq}..${op.endSeq}, which the surface does not hold`,
      )
    }
    const cited = new Set(op.coveredNodes)
    const uncited = nodes.slice(start, end + 1).filter(seq => !cited.has(seq))
    if (uncited.length > 0) {
      throw new DivergenceError(
        `fold for ${op.summaryId} does not cite the nodes it spans: ${uncited.join(', ')}`,
      )
    }
    if (!isJsonValue(foldBlocks(op.summary))) {
      throw new DivergenceError(`fold for ${op.summaryId} carries content the session log cannot store`)
    }
  }
  const claimed = new Set<number>()
  for (const op of ops) {
    for (const seq of op.coveredNodes) {
      if (claimed.has(seq)) throw new DivergenceError(`two folds claim surface node ${seq}`)
      claimed.add(seq)
    }
  }
}

/**
 * Append each fold as its own metered transaction.
 *
 * The session validates the provenance of every replacement node, so nothing
 * here re-proves that an op lands where it says: the session resolves the range
 * positionally against the live surface — fold nodes carry late
 * replacement-message seqs while sitting at early positions, so a seq-value range
 * would be wrong — and refuses a range that names a node the op did not cite.
 * {@link assertFoldOpsApply} is what makes those refusals unreachable, and it
 * runs before the first bracket opens rather than between two of them.
 *
 * Provenance comes from the route the runtime was opened with; re-resolving it
 * here would fabricate an empty options bag and write `''` into the fold
 * message's model source, which session seed validation rejects on fork and
 * replay. A `RequestContext` carries that route whole, so the caller hands over
 * the session's own.
 *
 * @param session - the live session the folds land in.
 * @param ops - the folds to land, already widened to pair-safe boundaries by the
 *   planner.
 * @param turn - the turn the events belong to, or null outside a turn. The
 *   replacement message records 0 in that case, since it requires a number.
 * @param step - the step the replacement message is stamped with: the step the
 *   pass is preparing inside a turn, or 0 outside one. A fold lands before the
 *   step it was planned for starts, so the step names where the recollection
 *   belongs rather than a step the session already holds.
 * @param route - the route the runtime was opened with, supplying the provider
 *   and model recorded as the folds' provenance. The session's own
 *   `requestContext()` is the value intended here.
 * @returns one result per op, in the order the ops landed.
 */
export function applyFolds(
  session: Session,
  ops: readonly FoldOp[],
  turn: number | null,
  step: number,
  route: RequestContext,
): CompactionResult[] {
  assertFoldOpsApply(session, ops)
  return ops.map(op => land(session, op, turn, step, route))
}

/**
 * Append one fold as a metered transaction.
 *
 * The single-op form of {@link applyFolds}: the one place a caller with exactly
 * one planned fold goes, so the preflight is the same one. The bracket id and
 * the fold node's compaction id are the same, as the protocol requires, which is
 * also how the node identifies the recollection it stands for —
 * {@link foldIdOf} reads it back without parsing the prose.
 *
 * @param session - the live session the fold lands in.
 * @param op - the fold to land, already widened to pair-safe boundaries by the
 *   planner.
 * @param turn - the turn the events belong to, or null outside a turn.
 * @param step - the step the replacement message is stamped with, as
 *   {@link applyFolds} defines it.
 * @param route - the route the runtime was opened with, supplying the provider
 *   and model recorded as the fold's provenance.
 * @returns the landed fold: the compaction id, the start, summary and end seqs,
 *   the fold's blocks, and the shadowed range, seqs and token count.
 */
export function applyFold(
  session: Session,
  op: FoldOp,
  turn: number | null,
  step: number,
  route: RequestContext,
): CompactionResult {
  return applyFolds(session, [op], turn, step, route)[0] as CompactionResult
}

/** One op's bracket, summary and replacement node. */
function land(
  session: Session,
  op: FoldOp,
  turn: number | null,
  step: number,
  route: RequestContext,
): CompactionResult {
  const compactionId = CompactionId(foldCompactionId(op.summaryId))
  const summary = foldBlocks(op.summary)
  const startSeq = session.append('compaction/start', { compactionId, turn }).seq

  const summarySeq = session.append('compaction/summary', {
    compactionId,
    summary,
    shadowedRange: { start: op.startSeq, end: op.endSeq },
    shadowedSeqs: [...op.shadowedSeqs],
    shadowedTokenCount: op.shadowedTokens,
    provider: route.provider,
    model: route.model,
  }).seq

  // One node for the whole range, so a fold never has to keep track of which
  // half of a round it took: the replacement is appended synchronously after its
  // metering event, as the pricing protocol requires.
  session.append('assistant/message', {
    turn: turn ?? 0,
    step,
    message: createAssistantMessage({
      content: summary,
      source: { provider: route.provider, model: route.model, compactionId },
    }),
  }, {
    surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq },
    sourceEventSeqs: [...op.coveredNodes],
  })

  return {
    compactionId,
    startSeq,
    summarySeq,
    endSeq: session.append('compaction/end', { compactionId, turn }).seq,
    summary,
    shadowedRange: { start: op.startSeq, end: op.endSeq },
    shadowedSeqs: [...op.shadowedSeqs],
    shadowedTokenCount: op.shadowedTokens,
  }
}
