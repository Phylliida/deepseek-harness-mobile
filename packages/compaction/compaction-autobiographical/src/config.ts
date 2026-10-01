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

/** Apply the harness defaults over the plugin config. */
export function resolveConfig(
  config: AutobiographicalCompactionConfig,
): ResolvedAutobiographicalConfig {
  return {
    ...config.operatingWindowTokens === undefined
      ? {}
      : { operatingWindowTokens: config.operatingWindowTokens },
    reserveTokens: config.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    auto: config.auto ?? true,
    strategy: config.strategy ?? {},
  }
}
