/**
 * Canonical form of the coding-activity log: the shared interaction record
 * every connected browser contributes to. Interactions enter as millisecond
 * stamps; the canonical document stores maximal SPANS — runs of stamps whose
 * adjacent gaps stay strictly under {@link CODING_ACTIVITY_BRIDGE_MS}. One
 * normalization ({@link mergeSpans}) sorts, clamps, and bridge-merges, and it
 * is associative and commutative, so stamps and spans from concurrent devices
 * merge to the same document regardless of arrival order. A stamp with no
 * neighbor inside the bridge window survives as a zero-length span: it counts
 * no time itself but anchors a future bridge, exactly the timer rule (taps
 * at minutes 1, 2, 5, 6, 7, 10, 11 total 1 + 2 + 1 minutes).
 *
 * @module @deepseek-ai/dsh-coding-activity/document
 */

/** Adjacent interactions closer than this bridge into one continuous coding span. */
export const CODING_ACTIVITY_BRIDGE_MS = 120_000

/** On-disk and wire format version; there is no migration promise across versions. */
export const CODING_ACTIVITY_FORMAT_VERSION = 1

/**
 * How far ahead of the Host clock an incoming stamp may be. Devices with a
 * fast clock record their bursts in the near future; beyond one vanity-width
 * window the stamp is a configuration error, not clock skew.
 */
export const CODING_ACTIVITY_MAX_FUTURE_SKEW_MS = 600_000

/** One coding stretch: `start <= end` epoch milliseconds, inclusive instants. */
export interface CodingSpan {
  /** First interaction of the run (epoch ms). */
  start: number
  /** Last interaction of the run (epoch ms); equals `start` for a lone stamp. */
  end: number
}

/** The persisted coding-activity document. */
export interface CodingActivityDocument {
  /** Format marker; equals {@link CODING_ACTIVITY_FORMAT_VERSION}. */
  version: 1
  /** Monotonic write counter; bumped on every content-changing write. */
  revision: number
  /** Canonical bridge-merged spans, ascending and disjoint by construction. */
  spans: CodingSpan[]
}

/** Wire/store view of the log: the document minus its format marker. */
export interface CodingActivityView {
  /** Monotonic revision the view was read at. */
  revision: number
  /** Canonical spans (ascending, bridge-disjoint). */
  spans: CodingSpan[]
}

/**
 * An append batch: raw interaction stamps and/or whole spans (the legacy
 * migration's completed sessions). Both fold through the same normalization.
 */
export interface CodingActivityEntry {
  /** Interaction stamps (epoch ms); each folds in as a zero-length span. */
  stamps?: number[]
  /** Whole spans to merge (epoch ms pairs). */
  spans?: CodingSpan[]
}

/** @returns the empty v1 document. */
export function emptyCodingActivityDocument(): CodingActivityDocument {
  return { version: CODING_ACTIVITY_FORMAT_VERSION, revision: 0, spans: [] }
}

/**
 * Canonicalize a span set: sort by start, clamp inverted spans, and
 * bridge-merge — a following span whose start is strictly less than
 * {@link CODING_ACTIVITY_BRIDGE_MS} after the merged run's end joins the run
 * (a gap of exactly the bridge width does NOT: "less than two minutes" is
 * strict). The result is ascending and bridge-disjoint.
 * @param spans - spans in any order, possibly overlapping or inverted.
 * @returns the canonical sorted, merged list.
 */
export function mergeSpans(spans: Iterable<CodingSpan>): CodingSpan[] {
  const rest: { start: number; end: number }[] = []
  for (const span of spans) rest.push({ start: span.start, end: Math.max(span.start, span.end) })
  rest.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: CodingSpan[] = []
  let run: { start: number; end: number } | undefined
  for (const span of rest) {
    if (run === undefined || span.start - run.end >= CODING_ACTIVITY_BRIDGE_MS) {
      run = { start: span.start, end: span.end }
      merged.push(run)
      continue
    }
    if (span.end > run.end) run.end = span.end
  }
  return merged
}

/**
 * Fold one append batch into canonical spans. Stamps enter as zero-length
 * spans, so a stamp strictly inside the bridge window of an existing tail
 * extends it, and out-of-order stamps from another device rebalance through
 * the merge.
 * @param spans - the current canonical spans.
 * @param entry - stamps and/or whole spans to incorporate.
 * @returns the new canonical spans (unchanged reference order preserved when possible).
 */
export function foldEntry(spans: readonly CodingSpan[], entry: CodingActivityEntry): CodingSpan[] {
  const incoming: CodingSpan[] = [...spans]
  if (entry.spans !== undefined) incoming.push(...entry.spans)
  if (entry.stamps !== undefined) {
    for (const stamp of entry.stamps) incoming.push({ start: stamp, end: stamp })
  }
  return mergeSpans(incoming)
}

/**
 * Narrow a decoded JSON value to {@link CodingActivityDocument}. The file
 * boundary is the one place the document is untyped; any deviation from the
 * v1 format rejects so a hand-edited or future-format file fails loud rather
 * than silently zeroing the log.
 * @param value - JSON-parsed file content.
 * @returns the document, or undefined when the content is not the v1 format.
 */
export function parseCodingActivityDocument(value: unknown): CodingActivityDocument | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== CODING_ACTIVITY_FORMAT_VERSION) return undefined
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) return undefined
  if (!Array.isArray(record.spans)) return undefined
  for (const span of record.spans) {
    if (typeof span !== 'object' || span === null) return undefined
    const row = span as Record<string, unknown>
    if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end)) return undefined
    if ((row.start as number) < 0 || (row.end as number) < (row.start as number)) return undefined
  }
  return {
    version: CODING_ACTIVITY_FORMAT_VERSION,
    revision: record.revision as number,
    spans: record.spans as CodingSpan[],
  }
}
