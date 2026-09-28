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

import { deriveEventMessage, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
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
  /** Tool-call ids this node's message declares (assistant messages). */
  readonly calls: readonly string[]
  /** Tool-call ids this node's message answers (tool-result blocks). */
  readonly results: readonly string[]
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
    const calls: string[] = []
    const results: string[] = []
    const message = event === undefined ? null : deriveEventMessage(event)
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-call') calls.push(block.id)
      if (block.type === 'tool-result') results.push(block.toolCallId)
    }
    return {
      seq,
      foldId: event === undefined ? undefined : foldNodeSummaryId(event),
      covers: coverageOf(seq, new Set()),
      calls,
      results,
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
  // Surface seqs a fold span absorbed beyond its planned range to keep a
  // tool call and its result on the same side of the fold.
  const absorbed = new Set<number>()
  let at = 0
  for (const item of desired) {
    // A node absorbed into a preceding fold's pair repair is consumed
    // already; its raw entry stands down (checked before the surface guard:
    // trailing absorbed nodes leave no surface node behind to compare).
    if (item.kind === 'raw' && absorbed.has(item.seq)) continue
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
    // Tool-pair repair: a fold may not shadow exactly one half of a tool
    // call/result pair — the wire demands the result follow its call, so a
    // straddling fold orphans the visible half and every later request 400s.
    // Widen the span to shadow both halves; the pair's exchange rides the
    // fold's recollection instead of the raw record. (Shrinking is not an
    // option: the walk consumes the surface contiguously.)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- span is non-empty past the guards above
    const first = span[0]!
    const prev = at > 0 ? surface[at - 1] : undefined
    if (first.results.length > 0 && prev !== undefined && prev.foldId === undefined) {
      // The result's call sits raw immediately before the span: pull it in,
      // or refuse when the adjacency invariant does not hold at all.
      if (!first.results.every(id => prev.calls.includes(id))) return null
      span.unshift(prev)
    }
    // Calls inside the span still awaiting a visible result. One assistant
    // message can fan out several parallel calls, each answered by its own
    // result message — absorb until the set closes, not after one answer.
    const pending = new Set(span.flatMap(node => node.calls))
    for (const node of span) for (const id of node.results) pending.delete(id)
    for (;;) {
      if (pending.size === 0) break
      const next: SurfaceAnno | undefined = surface[cursor]
      // No neighbor, or a folded one: the result is absent or already
      // invisible, so nothing orphans.
      if (next === undefined || next.foldId !== undefined) break
      if (next.results.length === 0 || !next.results.every(id => pending.has(id))) return null
      span.push(next)
      absorbed.add(next.seq)
      cursor++
      for (const id of next.results) pending.delete(id)
      for (const id of next.calls) pending.add(id)
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
