/** Rate-table arithmetic behind the session cost estimate, shared by both halves. */

import type { CostRates } from './cost-settings.ts'

/** The four disjoint durable billing buckets the estimate prices. */
export interface TokenBuckets {
  /** Prompt tokens billed at the uncached-input rate. */
  uncachedInputTokens: number
  /** Prompt tokens billed at the cache-read (hit) rate. */
  cacheReadTokens: number
  /** Prompt tokens billed at the cache-write rate. */
  cacheWriteTokens: number
  /** Output tokens billed at the output rate. */
  outputTokens: number
}

/**
 * Price the durable token buckets at the configured rates.
 * @param buckets - cumulative token counts from the durable log.
 * @param rates - per-million-token USD prices.
 * @returns the estimated spend in USD.
 */
export function estimateCost(buckets: TokenBuckets, rates: CostRates): number {
  return (
    buckets.uncachedInputTokens * rates.input
    + buckets.cacheReadTokens * rates.cacheRead
    + buckets.cacheWriteTokens * rates.cacheWrite
    + buckets.outputTokens * rates.output
  ) / 1_000_000
}

/**
 * Compact USD figure: four decimals under a cent, three under a dollar, two
 * from there on, `~` prefixed because the figure is an estimate.
 * @param cost - estimated spend in USD.
 * @returns display string.
 */
export function formatCost(cost: number): string {
  if (cost <= 0) return '~$0'
  if (cost < 0.01) return `~$${cost.toFixed(4)}`
  if (cost < 1) return `~$${cost.toFixed(3)}`
  return `~$${cost.toFixed(2)}`
}

/**
 * Share of the weekly budget the estimate represents: `<0.1%` when nonzero
 * but below one permille, tenths under a hundred, whole percents on.
 * @param cost - estimated spend in USD.
 * @param weeklyBudgetUsd - weekly budget in USD; the caller gates on `> 0`.
 * @returns display string.
 */
export function formatBudgetPercent(cost: number, weeklyBudgetUsd: number): string {
  const percent = (cost / weeklyBudgetUsd) * 100
  const tenths = Math.round(percent * 10) / 10
  if (tenths === 0) return cost > 0 ? '<0.1%' : '0%'
  if (tenths >= 100) return `${Math.round(percent)}%`
  return `${tenths}%`
}

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M (one decimal under three digits).
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}
