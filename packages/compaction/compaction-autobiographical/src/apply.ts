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
import type { Session } from '@deepseek-ai/dsh-session'
import { foldBlocks, foldCompactionId } from './plan.ts'
import type { FoldOp } from './plan.ts'

/**
 * Prove the op lands where it says, before the bracket opens. Positional rather
 * than numeric: fold nodes carry late replacement-message seqs while sitting at
 * early surface positions, so a seq-value range would sweep in nodes the op never
 * spans.
 */
function assertLands(surfaceSeqs: readonly number[], op: FoldOp): void {
  const start = surfaceSeqs.indexOf(op.startSeq)
  const end = surfaceSeqs.indexOf(op.endSeq)
  if (start === -1 || end === -1 || start > end) {
    throw new Error(`fold ${op.summaryId} range ${op.startSeq}..${op.endSeq} does not resolve on the live surface`)
  }
  const cited = new Set(op.shadowedSeqs)
  const missing = surfaceSeqs.slice(start, end + 1).filter(seq => !cited.has(seq))
  if (missing.length > 0) {
    throw new Error(`fold ${op.summaryId} would shadow seqs ${missing.join(', ')} without citing them`)
  }
}

/**
 * Append one fold as a metered transaction.
 *
 * Provenance comes from the route the runtime was opened with; re-resolving it
 * here would fabricate an empty options bag and write `''` into the fold
 * message's model source, which session seed validation rejects on fork and
 * replay.
 *
 * The bracket id and the fold node's compaction id are the same, as the protocol
 * requires, which is also how the node identifies the recollection it stands for
 * — {@link foldIdOf} reads it back without parsing the prose.
 */
export function applyFold(
  session: Session,
  op: FoldOp,
  turn: number | null,
  step: number,
  route: { provider: string; model: string },
): CompactionResult {
  assertLands(session.surface.nodes, op)
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
