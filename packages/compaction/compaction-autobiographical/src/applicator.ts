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
  /** Estimated tokens the shadowed surface nodes occupy (what the fold reclaims). */
  readonly shadowedTokens: number
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
  /** Estimated tokens the node's message occupies (the mirror's estimator). */
  readonly tokens: number
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
 * Pre-flight every planned op against the live surface: a replace append
 * throws on uncited shadowed nodes, and executeFolds opens its bracket
 * BEFORE the appends — a mid-transaction provenance failure would strand an
 * open compaction and brick turn boundaries. The append layer validates
 * again; catching a bad plan here keeps the bracket from ever opening.
 */
export function assertFoldOpsApply(surfaceSeqs: readonly number[], ops: readonly FoldOp[]): void {
  for (const op of ops) {
    const shadowed = new Set(op.shadowedSeqs)
    const missing = surfaceSeqs.filter(seq => seq >= op.startSeq && seq <= op.endSeq && !shadowed.has(seq))
    if (missing.length > 0) {
      throw new Error(`fold ${op.summaryId} would shadow seqs ${missing.join(', ')} without citing them`)
    }
  }
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
    let chars = 0
    for (const block of message?.content ?? []) {
      if (block.type === 'tool-call') calls.push(block.id)
      if (block.type === 'tool-result') results.push(block.toolCallId)
      if (block.type === 'text') chars += block.text.length
    }
    return {
      seq,
      foldId: event === undefined ? undefined : foldNodeSummaryId(event),
      covers: coverageOf(seq, new Set()),
      calls,
      results,
      tokens: Math.ceil(chars / 4),
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
    // Stale coarser leftovers: a fold node whose coverage lies entirely
    // before this entry's range is content the layout has moved past. Leave
    // the node (a coarser fold only shrinks the context) and advance the
    // surface cursor only.
    let current = surface[at]
    while (current?.foldId !== undefined) {
      const maxCover = Math.max(...current.covers)
      const startsAfter = item.kind === 'raw' ? item.seq > maxCover : item.firstSeq > maxCover
      if (!startsAfter) break
      at++
      current = surface[at]
    }
    if (current === undefined) return null
    if (item.kind === 'raw') {
      // Surface coarser than the layout: the node holding this raw seq is a
      // fold the picker has since resolved finer (budget growth, pyramid
      // deepening). Keeping the fold only shrinks the context below plan, so
      // the raw entry stands down rather than stalling the pass.
      if (current.foldId !== undefined) {
        if (current.covers.includes(item.seq)) continue
      } else if (current.seq === item.seq) {
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
      if (node.foldId === undefined) {
        if (node.seq < item.firstSeq || node.seq > item.lastSeq) break
      } else {
        const contained = node.covers.length > 0
          && node.covers.every(seq => seq >= item.firstSeq && seq <= item.lastSeq)
        if (!contained) {
          // Head-edge straddle: an earlier pass folded this node's coverage
          // and the layout now wants a fold whose range merely starts inside
          // it. The node keeps the head (coarser only shrinks the context);
          // this fold shadows from the next node on. A replace op spans a
          // contiguous surface range, so only a leading node can be folded
          // around this way.
          if (span.length === 0 && node.covers.length > 0) {
            const minCover = Math.min(...node.covers)
            const maxCover = Math.max(...node.covers)
            if (item.firstSeq >= minCover && item.firstSeq <= maxCover && item.lastSeq > maxCover) {
              cursor++
              continue
            }
          }
          break
        }
      }
      span.push(node)
      cursor++
    }
    if (span.length === 0 && current.foldId !== undefined) {
      // The range intersects a fold node the picker no longer selects at
      // this granularity. Fully contained ranges are already covered by the
      // node; straddling ones keep it too — a coarser fold only ever shrinks
      // the context below the plan. Either way the entry stands down.
      const minCover = Math.min(...current.covers)
      const maxCover = Math.max(...current.covers)
      if (item.firstSeq >= minCover && item.lastSeq <= maxCover) continue
      if (item.firstSeq <= maxCover && item.lastSeq >= minCover) continue
    }
    if (span.length === 0) return null
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
    //
    // Backward direction: every result the span shadows whose call is NOT
    // also shadowed needs its call pulled in from the raw nodes before the
    // span — chained, since a pulled-in node may itself carry results whose
    // calls sit further upstream. When the span starts right after a fold
    // node, pull nothing: a needed call raw further upstream means the fold
    // would orphan it, so the pass refuses instead.
    const spanCalls = new Set(span.flatMap(node => node.calls))
    const needed = new Set(span.flatMap(node => node.results).filter(id => !spanCalls.has(id)))
    while (needed.size > 0) {
      // The span is contiguous on the surface, so its head sits at
      // cursor - span.length regardless of any fold-around skip at collect
      // time (indexing from `at` here would misread a folded-around node).
      const headIndex = cursor - span.length
      const prev = headIndex > 0 ? surface[headIndex - 1] : undefined
      if (prev === undefined) break
      if (prev.foldId !== undefined) {
        for (let i = headIndex - 2; i >= 0; i--) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
          const earlier = surface[i]!
          if (earlier.foldId === undefined && earlier.calls.some(id => needed.has(id))) return null
        }
        break
      }
      if (!prev.calls.some(id => needed.has(id))) return null
      span.unshift(prev)
      for (const id of prev.calls) needed.delete(id)
      for (const id of prev.results) needed.add(id)
    }
    // Calls inside the span still awaiting a visible result. One assistant
    // message can fan out several parallel calls, each answered by its own
    // result message — absorb until the set closes, not after one answer.
    const pending = new Set(span.flatMap(node => node.calls))
    for (const node of span) for (const id of node.results) pending.delete(id)
    for (;;) {
      if (pending.size === 0) break
      const next: SurfaceAnno | undefined = surface[cursor]
      // No neighbor: the result never reached the surface, so nothing orphans.
      if (next === undefined) break
      if (next.foldId !== undefined) {
        // The result may still be RAW past the fold node — visible exactly
        // where its call is about to vanish. Refuse rather than orphan it.
        for (let i = cursor + 1; i < surface.length; i++) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
          const later = surface[i]!
          if (later.foldId === undefined && later.results.some(id => pending.has(id))) return null
        }
        break
      }
      // A result answering a call OUTSIDE the span would orphan that call;
      // anything else (in-step results, pair-free splices) absorbs safely.
      if (!next.results.every(id => pending.has(id))) return null
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
      shadowedTokens: span.reduce((total, node) => total + node.tokens, 0),
      text: item.text,
    })
    at = cursor
  }
  return ops
}
