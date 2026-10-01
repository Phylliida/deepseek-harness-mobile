/**
 * Config resolution for the autobiographical backend.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/config
 */

import type {
  AutobiographicalCompactionConfig,
  ResolvedAutobiographicalConfig,
} from './types.ts'

/** Default response reserve inside the compile budget. */
const DEFAULT_RESERVE_TOKENS = 8192

/**
 * Default ceiling for the live context, in tokens.
 *
 * Models degrade well before their advertised window, so the operating point
 * sits here whatever the route advertises. This is the *default* for the cap and
 * not a floor over it: a caller that names a window means it.
 */
export const OPERATING_WINDOW_CAP = 65_536

/**
 * Apply the harness defaults over the plugin config.
 *
 * @param config - The plugin config as the host declared it. Every field is
 * optional; an absent field takes its default here and nowhere else.
 * @returns The runtime config, with `operatingWindowTokens` and `reserveTokens`
 * both resolved to numbers so no later reader has to decide what absent meant.
 */
export function resolveConfig(
  config: AutobiographicalCompactionConfig,
): ResolvedAutobiographicalConfig {
  return {
    operatingWindowTokens: config.operatingWindowTokens ?? OPERATING_WINDOW_CAP,
    reserveTokens: config.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    auto: config.auto ?? true,
    strategy: config.strategy ?? {},
  }
}
