/**
 * Configuration vocabulary and log-record shapes for the autobiographical
 * compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/types
 */

import type { AutobiographicalOptions, AutobiographicalStrategy } from '@animalabs/context-manager'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Strategy-progress counters the chat's memory row displays. */
type StrategyStats = ReturnType<AutobiographicalStrategy['getStats']>

/** Knobs accepted by the plugin config; every field is optional. */
export interface AutobiographicalCompactionConfig {
  /**
   * Ceiling for the context the strategy keeps live, reached by folding aged
   * history. Defaults to the routed model's window, capped at 65_536: models
   * degrade well before their advertised window, so the operating point stays
   * there regardless of route.
   */
  operatingWindowTokens?: number
  /** Tokens reserved for the model's response inside the compile budget; default 8192. */
  reserveTokens?: number
  /** Register the step-boundary folding listener; default true. */
  auto?: boolean
  /**
   * Strategy knobs handed to `AutobiographicalStrategy` untouched, so
   * upstream options (`kvStableReachTokens`, `speculativeProduction`,
   * `summaryTargetTokens`, …) flow with the library version instead of
   * being mirrored here one field at a time.
   */
  strategy?: AutobiographicalOptions
}

/** Runtime configuration: the harness defaults applied over the plugin config. */
export interface ResolvedAutobiographicalConfig {
  operatingWindowTokens?: number
  reserveTokens: number
  auto: boolean
  strategy: AutobiographicalOptions
}

/** The recollection one memory-formation call minted. */
export interface AutobiographicalMemoryMint {
  id: string
  level: number
  content: string
  tokens: number
  /** Mint time, preserved so a replayed recollection keeps its place in the pyramid. */
  created: number
  /**
   * Surface seqs of the span this recollection replaces. Stamped at mint time
   * because the log carries no other record of coverage, and re-seeding needs
   * it to rebuild the pyramid.
   */
  sourceRange?: { firstSeq: number; lastSeq: number }
}

/** Log-only record of one memory-formation tick, written when a tick has news. */
export interface AutobiographicalMemoryEventData extends StrategyStats {
  /** Bridge calls the session has settled; the counter a replayed log reconstructs. */
  attempt: number
  /** Present when the tick minted a recollection; absent when it only advanced the pyramid. */
  memory?: AutobiographicalMemoryMint
  /**
   * The newest settled call's provider-reported usage. Memory formation pays
   * real tokens outside any turn, so the tokenUsage projection folds these
   * records into the session's cost accounting.
   */
  usage?: TokenUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one memory-formation tick that has news to report. */
    'autobio/memory': AutobiographicalMemoryEventData
  }
}

/**
 * Fixed-density sizing for one surface node. Deliberately crude, and only ever
 * reported: `compaction/summary` carries `shadowedTokenCount` as the fold's
 * claim on the ground it replaces, which the token meter delta-accounts.
 *
 * The compile budget does not read this. The manager prices its own store with a
 * density-aware estimator, so passing this one to `ContextManager.open` would
 * replace a measured heuristic with a cruder one and misprice every pick.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
