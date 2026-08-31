/** Quota-segment formatting for the cost line: pure functions over the Remote snapshot. */

import type { KimiQuotaSnapshot, KimiQuotaUsageRow } from '@deepseek-ai/dsh-api-remotes/client'
import type { CostKey } from './locales.ts'

/** The locale seat the formatting helpers read (the component's `t` prop). */
export type CostTranslate = (key: CostKey, params: Record<string, string>) => string

/**
 * `21%` on the platform's percent-scaled rows, `21/300` on absolute caps.
 * @param row - one allowance row.
 * @returns the compact usage text.
 */
export function formatQuotaUsage(row: KimiQuotaUsageRow): string {
  return row.limit === 100 ? `${String(row.used)}%` : `${String(row.used)}/${String(row.limit)}`
}

/**
 * Window label from its length: whole hours read as `5h`, anything else as minutes.
 * @param windowMinutes - window length in minutes.
 * @param t - the component's locale seat.
 * @returns the localized window label.
 */
export function formatWindowLabel(windowMinutes: number, t: CostTranslate): string {
  if (windowMinutes % 60 === 0) return t('quotaWindowHours', { count: String(windowMinutes / 60) })
  return t('quotaWindowMinutes', { count: String(windowMinutes) })
}

/** One row's segment text: `{label} {usage}` such as `5h 21%` or `wk 32%`. */
function segment(label: string, row: KimiQuotaUsageRow): string {
  return `${label} ${formatQuotaUsage(row)}`
}

/**
 * The compact quota segment appended to the cost line: rolling windows
 * first, then the weekly and monthly allowances when reported.
 * @param snapshot - the current Remote snapshot.
 * @param t - the component's locale seat.
 * @returns segments joined by ` · `, or an empty string when nothing was reported.
 */
export function formatQuotaSegments(snapshot: KimiQuotaSnapshot, t: CostTranslate): string {
  const parts: string[] = snapshot.windows.map(row => segment(formatWindowLabel(row.windowMinutes, t), row))
  if (snapshot.weekly !== null) parts.push(segment(t('quotaWeekly', {}), snapshot.weekly))
  if (snapshot.monthly !== null) parts.push(segment(t('quotaMonthly', {}), snapshot.monthly))
  return parts.join(' · ')
}

/** `2d 3h 4m`-style duration; sub-minute gaps read as minutes rounded up. */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const mins = minutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${String(days)}d`)
  if (hours > 0) parts.push(`${String(hours)}h`)
  if (mins > 0 || parts.length === 0) parts.push(`${String(mins)}m`)
  return parts.join(' ')
}

/** One tooltip clause: `{label} {usage}` plus the reset hint when the platform reported it. */
function tooltipClause(label: string, row: KimiQuotaUsageRow, t: CostTranslate, now: number): string {
  const head = segment(label, row)
  if (row.resetAt === undefined) return head
  const resetMs = Date.parse(row.resetAt)
  if (!Number.isFinite(resetMs)) return head
  const hint = resetMs <= now ? t('quotaReset', {}) : t('quotaResetsIn', { duration: formatDuration(resetMs - now) })
  return `${head} (${hint})`
}

/**
 * The tooltip detail for the quota segment: every reported row with its reset hint.
 * @param snapshot - the current Remote snapshot.
 * @param t - the component's locale seat.
 * @param now - the reference instant for relative reset hints (injectable for tests).
 * @returns the titled detail text, or an empty string when nothing was reported.
 */
export function formatQuotaTooltip(snapshot: KimiQuotaSnapshot, t: CostTranslate, now: number = Date.now()): string {
  const parts: string[] = snapshot.windows.map(row =>
    tooltipClause(formatWindowLabel(row.windowMinutes, t), row, t, now))
  if (snapshot.weekly !== null) parts.push(tooltipClause(t('quotaWeekly', {}), snapshot.weekly, t, now))
  if (snapshot.monthly !== null) parts.push(tooltipClause(t('quotaMonthly', {}), snapshot.monthly, t, now))
  if (parts.length === 0) return ''
  return `${t('quotaTitle', {})}: ${parts.join(' · ')}`
}
