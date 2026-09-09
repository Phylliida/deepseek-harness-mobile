/**
 * Pure read-side projections of the coding-activity snapshot. Every surface
 * (sidebar row, calendar, gate cover) derives from {@link displaySpans}, so
 * they can never disagree: the pending local stamps fold through the same
 * canonical bridge merge the server applies, and a live tail extends to the
 * render instant. Total math lives in totals.ts; this module is only the
 * snapshot → display projection.
 */
import { CODING_ACTIVITY_BRIDGE_MS, mergeSpans } from '@deepseek-ai/dsh-coding-activity/document'
import type { CodingSpanView } from '@deepseek-ai/dsh-client-connection/client'
import type { CodingActivitySnapshot } from './activity.ts'

/** The one span projection every surface reads. */
export interface DisplayActivity {
  /**
   * Spans for totals: the canonical server spans, pending stamps folded in,
   * and a live tail extended to now while the render instant sits inside the
   * bridge window of the last interaction (any device). A broken clock skew —
   * now behind the tail — leaves the span alone.
   */
  spans: CodingSpanView[]
  /** Whether the user is interacting within the bridge window right now. */
  live: boolean
}

/**
 * Project one snapshot to display spans.
 * @param snapshot - the activity controller's current snapshot.
 * @param now - render instant (epoch ms).
 * @returns totals-ready spans plus the live flag.
 */
export function displaySpans(snapshot: Pick<CodingActivitySnapshot, 'spans' | 'pendingStamps'>, now: number): DisplayActivity {
  const merged = mergeSpans([
    ...snapshot.spans,
    ...snapshot.pendingStamps.map(stamp => ({ start: stamp, end: stamp })),
  ])
  const tail = merged[merged.length - 1]
  const live = tail !== undefined && now >= tail.end && now - tail.end < CODING_ACTIVITY_BRIDGE_MS
  if (!live || tail === undefined) return { spans: merged, live: false }
  const extended = merged.slice()
  extended[extended.length - 1] = { start: tail.start, end: now }
  return { spans: extended, live: true }
}
