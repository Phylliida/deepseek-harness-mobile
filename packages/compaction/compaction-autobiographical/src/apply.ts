/**
 * Landing one fold: a bracketed, metered compaction transaction.
 *
 * Deliberately dumb. Planning already widened the op to pair-safe boundaries, so
 * nothing here reasons about tool pairing — it writes what it is given or throws.
 * That is the point of the split: the old applicator decided layout while it
 * applied, which is where its chaining, absorbed-node bookkeeping and refusal
 * paths came from.
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
import type { RequestContext, Session } from '@deepseek-ai/dsh-session'
import { foldBlocks, foldCompactionId } from './plan.ts'
import type { FoldOp } from './plan.ts'

/**
 * Append one fold as a metered transaction.
 *
 * The session validates the provenance of the replacement node, so nothing here
 * re-proves that the op lands where it says: the session resolves the range
 * positionally against the live surface — fold nodes carry late
 * replacement-message seqs while sitting at early positions, so a seq-value range
 * would be wrong — and refuses a range that names a node the op did not cite.
 *
 * Provenance comes from the route the runtime was opened with; re-resolving it
 * here would fabricate an empty options bag and write `''` into the fold
 * message's model source, which session seed validation rejects on fork and
 * replay. A `RequestContext` carries that route whole, so the caller hands over
 * the session's own.
 *
 * The bracket id and the fold node's compaction id are the same, as the protocol
 * requires, which is also how the node identifies the recollection it stands for
 * — {@link foldIdOf} reads it back without parsing the prose.
 *
 * @param session - the live session the fold lands in.
 * @param op - the fold to land, already widened to pair-safe boundaries by the
 * planner.
 * @param turn - the turn the events belong to, or null outside a turn. The
 * replacement message records 0 in that case, since it requires a number.
 * @param step - the step within the turn the replacement message is stamped
 * with; it is not advanced, and must be the step the session already holds.
 * @param route - the route the runtime was opened with, supplying the provider
 * and model recorded as the fold's provenance. The session's own
 * `requestContext()` is the value intended here.
 * @returns the landed fold: the compaction id, the start, summary and end seqs,
 * the fold's blocks, and the shadowed range, seqs and token count.
 */
export function applyFold(
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
    sourceEventSeqs: [...op.shadowedSeqs],
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
