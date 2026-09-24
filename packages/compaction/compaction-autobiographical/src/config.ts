/**
 * Config resolution for the autobiographical compaction backend. The loader
 * schema lives inline on `AutobiographicalCompactionEngine.Config` (the config
 * catalog generator statically walks it there).
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/config
 */

import type {
  AutobiographicalCompactionConfig,
  ResolvedAutobiographicalConfig,
} from './types.ts'

/**
 * Resolve the plugin config. The window sizes default to the values
 * connectome-host ships for its agents; every other strategy knob passes
 * through untouched so the library's own defaults rule. Memory formation
 * always runs on the session's own routed model — autobiographical summaries
 * are the agent writing about its own history, so a different model would be
 * a substitute voice (and a second paid model route).
 */
export function resolveConfig(
  config: AutobiographicalCompactionConfig,
): ResolvedAutobiographicalConfig {
  return {
    storeRoot: config.storeRoot ?? '.dsh/autobio',
    ...config.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: config.contextWindowTokens },
    ...config.contextWindowTokensByModel === undefined
      ? {}
      : { contextWindowTokensByModel: config.contextWindowTokensByModel },
    reserveTokens: config.reserveTokens ?? 8192,
    recentWindowTokens: config.recentWindowTokens ?? 30_000,
    headWindowTokens: config.headWindowTokens ?? 4000,
    maxMessageTokens: config.maxMessageTokens ?? 10_000,
    ...config.targetChunkTokens === undefined ? {} : { targetChunkTokens: config.targetChunkTokens },
    ...config.mergeThreshold === undefined ? {} : { mergeThreshold: config.mergeThreshold },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    // connectome-host pins kv-stable for its agents: the library fallback
    // (flat-profile) replans layouts without prompt-cache stability.
    foldingStrategy: config.foldingStrategy ?? 'kv-stable',
    auto: config.auto ?? true,
  }
}
