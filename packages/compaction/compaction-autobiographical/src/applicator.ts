/**
 * Frontier applicator: reconciles the autobiographical strategy's selected
 * context layout onto the harness session surface. The harness log stays the
 * single source of truth — a fold lands as one `assistant/message` replace
 * node whose text is the model's own first-person recollection, so surface
 * replay, token metering, and the human transcript keep working unchanged.
 *
 * Planning is a pure function over the parsed entries and the annotated
 * surface; the engine executes the returned ops. Planning never grows the
 * node count inside a region: a fold shadows one or more current nodes with
 * exactly one recollection node, and refinement of an already-folded span
 * (which would need several nodes where one stands) is clamped — the coarser
 * recollection stays on the surface while the archive retains every level.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/applicator
 */

import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextEntry } from '@animalabs/context-manager'
import { messageSeq } from './mirror.ts'
import type { SessionRuntime } from './mirror.ts'

/** One planned fold: shadow `startSeq..endSeq` (current surface nodes) with one recollection node. */
export interface FoldOp {
  readonly summaryId: string
  readonly level: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  /** Rendered recollection text, recall header included. */
  readonly text: string
}

/** Desired surface item parsed from the strategy's selected entries. */
type DesiredItem =
  | { readonly kind: 'raw'; readonly seq: number }
  | {
    readonly kind: 'fold'
    readonly summaryId: string
    readonly level: number
    readonly firstSeq: number
    readonly lastSeq: number
    readonly text: string
  }

/** One annotated surface node: an original append, or a fold node with its expanded coverage. */
interface SurfaceAnno {
  readonly seq: number
  readonly foldId: string | undefined
  readonly covers: readonly number[]
}

const RECALL_HEADER = /^\[Recall (\S+)\]/

/**
 * Whether one event is one of this backend's fold nodes: an assistant
 * replacement whose text opens with the recall header written at apply time.
 */
function foldNodeSummaryId(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message' || !isReplacementSurfaceEvent(event)) return undefined
  const first = event.data.message.content[0]
  if (first?.type !== 'text') return undefined
  return RECALL_HEADER.exec(first.text)?.[1]
}

/**
 * Annotate the current surface: each node's coverage in original append-event
 * seqs. Fold and other replacement nodes expand through their cited source
 * seqs so a fold's footprint stays comparable across fold levels.
 */
function annotateSurface(session: Session): SurfaceAnno[] {
  const bySeq = new Map<number, SessionEvent>()
  for (const event of session.events) bySeq.set(event.seq, event)

  const coverageCache = new Map<number, readonly number[]>()
  const coverageOf = (seq: number, seen: Set<number>): readonly number[] => {
    const cached = coverageCache.get(seq)
    if (cached !== undefined) return cached
    if (seen.has(seq)) return [seq]
    seen.add(seq)
    const event = bySeq.get(seq)
    const sources = event !== undefined && isReplacementSurfaceEvent(event)
      ? event.sourceEventSeqs
      : undefined
    const covers = sources === undefined || sources.length === 0
      ? [seq]
      : sources.flatMap(source => coverageOf(source, seen))
    coverageCache.set(seq, covers)
    return covers
  }

  return session.surface.nodes.map((seq) => {
    const event = bySeq.get(seq)
    return {
      seq,
      foldId: event === undefined ? undefined : foldNodeSummaryId(event),
      covers: coverageOf(seq, new Set()),
    }
  })
}

/**
 * Parse the strategy's selected entries into desired surface items. A recall
 * pair (a `Context Manager` question carrying the `[Recall id]` header and
 * the agent-voice answer) becomes one fold item; raw copies map to their
 * mirrored seq. Unresolvable entries abort the pass (return null) rather than
 * plan against a partially understood layout.
 */
function parseDesired(
  runtime: SessionRuntime,
  entries: readonly ContextEntry[],
): DesiredItem[] | null {
  const items: DesiredItem[] = []
  for (let index = 0; index < entries.length; index++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    const entry = entries[index]!
    if (entry.sourceRelation === 'copy') {
      const sourceIds = entry.sourceMessageIds ?? (entry.sourceMessageId === undefined ? [] : [entry.sourceMessageId])
      if (sourceIds.length === 0) return null
      for (const id of sourceIds) {
        const seq = messageSeq(runtime, id)
        if (seq === undefined) return null
        items.push({ kind: 'raw', seq })
      }
      continue
    }
    if (entry.sourceRelation !== 'derived') continue
    // A recall question names nothing; the summary id rides the answer's cacheLayoutKey.
    const answer = entries[index + 1]
    if (answer?.sourceRelation !== 'derived' || answer.cacheLayoutKey === undefined) return null
    const summary = runtime.strategy.getSummary(answer.cacheLayoutKey)
    if (summary === null) return null
    const firstSeq = messageSeq(runtime, summary.sourceRange.first)
    const lastSeq = messageSeq(runtime, summary.sourceRange.last)
    if (firstSeq === undefined || lastSeq === undefined || firstSeq > lastSeq) return null
    const answerText = answer.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    items.push({
      kind: 'fold',
      summaryId: summary.id,
      level: summary.level,
      firstSeq,
      lastSeq,
      text: `[Recall ${summary.id}]\n\n${answerText}`,
    })
    index++
  }
  return items
}

/**
 * Plan the fold ops that reconcile the current surface with the strategy's
 * selected entries. Returns an empty list when the surface already matches;
 * returns null when the layout cannot be reconciled (the caller skips the
 * pass and retries on the next step).
 */
export function planFolds(
  session: Session,
  runtime: SessionRuntime,
  entries: readonly ContextEntry[],
): FoldOp[] | null {
  const desired = parseDesired(runtime, entries)
  if (desired === null) return null
  const surface = annotateSurface(session)

  const ops: FoldOp[] = []
  let at = 0
  for (const item of desired) {
    const current = surface[at]
    if (current === undefined) return null
    if (item.kind === 'raw') {
      if (current.foldId === undefined && current.seq === item.seq) {
        at++
        continue
      }
      // Refinement the single-node replace cannot express: the surface shows a
      // fold over this raw seq. Keep the coarser node (the archive retains
      // every level; the raw record is never deleted).
      if (current.foldId !== undefined && current.covers.includes(item.seq)) {
        at++
        continue
      }
      return null
    }

    // Fold item: collect the surface span covering exactly its seq range.
    const span: SurfaceAnno[] = []
    let cursor = at
    while (cursor < surface.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const node = surface[cursor]!
      const inside = node.foldId === undefined
        ? node.seq >= item.firstSeq && node.seq <= item.lastSeq
        : node.covers.length > 0 && node.covers.every(seq => seq >= item.firstSeq && seq <= item.lastSeq)
      if (!inside) break
      span.push(node)
      cursor++
    }
    if (span.length === 0) {
      // The range is already inside a coarser fold node (refinement): clamp.
      if (current.foldId !== undefined
        && item.firstSeq >= Math.min(...current.covers)
        && item.lastSeq <= Math.max(...current.covers)) {
        continue
      }
      return null
    }
    const [only] = span
    if (span.length === 1 && only !== undefined && only.foldId === item.summaryId) {
      at = cursor
      continue
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- span is non-empty past the guards above
    const firstSeq = span[0]!.seq
    // oxlint-disable-next-line typescript/no-non-null-assertion -- span is non-empty past the guards above
    const lastSeq = span[span.length - 1]!.seq
    ops.push({
      summaryId: item.summaryId,
      level: item.level,
      startSeq: firstSeq,
      endSeq: lastSeq,
      shadowedSeqs: span.map(node => node.seq),
      text: item.text,
    })
    at = cursor
  }
  return ops
}
