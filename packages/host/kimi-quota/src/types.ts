/**
 * Kimi Code subscription quota vocabulary shared by the Host fetcher, the
 * generated Remote artifacts, and Client readouts. Wire-facing: every field
 * is JSON-safe and optional-absent rather than `undefined`-valued.
 *
 * @module @deepseek-ai/dsh-host-kimi-quota/types
 */

/** One allowance row: requests used against a limit, with the platform reset instant when reported. */
export interface KimiQuotaUsageRow {
  /** Requests already consumed in the current window or period. */
  readonly used: number
  /** Request cap for the window or period; `100` doubles as a percent scale on current plans. */
  readonly limit: number
  /** ISO instant the allowance resets, when the platform reports it. */
  readonly resetAt?: string
}

/** One rolling rate-limit window (the 5-hour window on current Kimi Code plans). */
export interface KimiQuotaWindowRow extends KimiQuotaUsageRow {
  /** Window length in minutes; `300` is the rolling 5-hour window. */
  readonly windowMinutes: number
}

/**
 * Point-in-time Kimi Code subscription quota, fetched per call from the
 * platform `/usages` endpoint. A row is `null` when the platform payload does
 * not carry that allowance (the monthly membership quota is absent on plans
 * that never report it).
 */
export interface KimiQuotaSnapshot {
  /** ISO instant the Host fetched this snapshot. */
  readonly fetchedAt: string
  /** Rolling rate-limit windows, shortest first. */
  readonly windows: readonly KimiQuotaWindowRow[]
  /** Weekly allowance, when reported. */
  readonly weekly: KimiQuotaUsageRow | null
  /** Monthly membership allowance, when reported. */
  readonly monthly: KimiQuotaUsageRow | null
}
