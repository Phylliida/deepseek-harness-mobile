/** Cost-estimate preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the cost-estimate plugin. */
export const COST_SETTINGS_NAMESPACE = 'ui-cost-estimate'

/** Field carrying the rate table inside the namespace section. */
export const RATES_FIELD = 'rates'

/** Field carrying the weekly budget inside the namespace section. */
export const WEEKLY_BUDGET_FIELD = 'weeklyBudgetUsd'

/** One full rate table: token-class prices in USD per one million tokens. */
export interface CostRates {
  /** Price for uncached prompt tokens. */
  input: number
  /** Price for cached-read (cache-hit) prompt tokens. */
  cacheRead: number
  /** Price for cache-write prompt tokens. */
  cacheWrite: number
  /** Price for output tokens. */
  output: number
}

/**
 * Moonshot's published Kimi K3 standard API rates. Kimi K3 bills cache
 * writes as ordinary input, so `cacheWrite` matches `input`.
 */
export const DEFAULT_COST_RATES: CostRates = { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 }

/**
 * Weekly billing allowance the estimate is measured against, in USD; set to
 * `0` to drop the budget share from the line.
 */
export const DEFAULT_WEEKLY_BUDGET_USD = 120

/** Durable cost-estimate section shared by the Host schema and the browser scope. */
export interface CostEstimateSettings {
  /** Rate table the estimate multiplies the durable token buckets by. */
  rates: CostRates
  /** Weekly USD budget the estimate is shown as a percent of; `0` hides the share. */
  weeklyBudgetUsd: number
}

/** Durable cost-estimate schema; also the wire envelope the browser scope validates against. */
export const CostEstimateSettingsSchema: z<CostEstimateSettings> = z.object({
  [RATES_FIELD]: z.object({
    input: z.number().min(0).default(DEFAULT_COST_RATES.input),
    cacheRead: z.number().min(0).default(DEFAULT_COST_RATES.cacheRead),
    cacheWrite: z.number().min(0).default(DEFAULT_COST_RATES.cacheWrite),
    output: z.number().min(0).default(DEFAULT_COST_RATES.output),
  }).default(DEFAULT_COST_RATES),
  [WEEKLY_BUDGET_FIELD]: z.number().min(0).default(DEFAULT_WEEKLY_BUDGET_USD),
})
