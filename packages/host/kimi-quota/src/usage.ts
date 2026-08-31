/**
 * `/usages` fetch and payload parsing for the Kimi Code managed platform.
 *
 * The parser is deliberately loose: the platform has shipped numeric fields
 * as both numbers and decimal strings, spelled the reset instant `resetTime`
 * and `resetAt`, and nested window rows under `detail` beside their `window`
 * descriptor. Unknown or absent sections parse to `null`/empty rather than
 * failing the snapshot.
 */

import type { KimiQuotaSnapshot, KimiQuotaUsageRow, KimiQuotaWindowRow } from './types.ts'

/** Snapshot without its fetch stamp: the payload-derived portion. */
export type KimiQuotaPayload = Omit<KimiQuotaSnapshot, 'fetchedAt'>

/** Subset of the global fetch the usage request needs (the injection point for tests). */
export type KimiUsageFetch = (url: string, init: {
  headers: Record<string, string>
  signal: AbortSignal
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

function toInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resetAtOf(raw: Record<string, unknown>): string | undefined {
  for (const key of ['resetTime', 'resetAt', 'reset_time', 'reset_at']) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Parse one allowance row; `used` falls back to `limit - remaining`, and a missing limit fails the row. */
function toUsageRow(raw: unknown): KimiQuotaUsageRow | null {
  if (!isRecord(raw)) return null
  const limit = toInt(raw['limit'])
  if (limit === null || limit <= 0) return null
  let used = toInt(raw['used'])
  if (used === null) {
    const remaining = toInt(raw['remaining'])
    used = remaining === null ? 0 : Math.max(0, limit - remaining)
  }
  const resetAt = resetAtOf(raw)
  return { used, limit, ...(resetAt === undefined ? {} : { resetAt }) }
}

const MINUTES_PER_UNIT: readonly (readonly [marker: string, minutes: number])[] = [
  ['MINUTE', 1],
  ['HOUR', 60],
  ['DAY', 1_440],
  ['WEEK', 10_080],
]

/** Window length in minutes from a `{ duration, timeUnit }` descriptor, or null when either side is absent. */
function windowMinutesOf(raw: unknown): number | null {
  if (!isRecord(raw)) return null
  const duration = toInt(raw['duration'])
  const unit = raw['timeUnit'] ?? raw['time_unit']
  if (duration === null || duration <= 0 || typeof unit !== 'string') return null
  for (const [marker, minutes] of MINUTES_PER_UNIT) {
    if (unit.includes(marker)) return duration * minutes
  }
  return null
}

/**
 * Parse one platform `/usages` payload into the snapshot rows.
 * @param payload - decoded response body.
 * @returns the weekly row, rolling windows (shortest first), and monthly row.
 */
export function parseKimiUsagePayload(payload: unknown): KimiQuotaPayload {
  if (!isRecord(payload)) return { windows: [], weekly: null, monthly: null }
  const weekly = toUsageRow(payload['usage'])
  const monthly = toUsageRow(payload['totalQuota'])
  const windows: KimiQuotaWindowRow[] = []
  const rawLimits = payload['limits']
  if (Array.isArray(rawLimits)) {
    for (const item of rawLimits) {
      if (!isRecord(item)) continue
      const windowMinutes = windowMinutesOf(item['window'])
      if (windowMinutes === null) continue
      const detail = isRecord(item['detail']) ? item['detail'] : item
      const row = toUsageRow(detail)
      if (row === null) continue
      windows.push({ ...row, windowMinutes })
    }
  }
  windows.sort((a, b) => a.windowMinutes - b.windowMinutes)
  return { windows, weekly, monthly }
}

/**
 * GET `${baseUrl}/v1/usages` with the subscription API key.
 * @param baseUrl - managed platform origin plus path prefix, without a trailing slash.
 * @param apiKey - resolved credential value, sent as a Bearer token.
 * @param timeoutMs - request timeout.
 * @param fetchImpl - fetch implementation; the global fetch in production.
 * @returns the parsed payload rows.
 * @throws Error with the HTTP status or transport failure; callers decide the degraded behavior.
 */
export async function fetchKimiUsage(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: KimiUsageFetch = fetch,
): Promise<KimiQuotaPayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}/v1/usages`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`kimi quota: /usages answered HTTP ${String(response.status)}`)
    return parseKimiUsagePayload(await response.json())
  } finally {
    clearTimeout(timer)
  }
}
