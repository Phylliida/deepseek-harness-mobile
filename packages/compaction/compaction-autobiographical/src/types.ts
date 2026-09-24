/**
 * Configuration vocabulary for the autobiographical compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/types
 */

/** Knobs accepted by the plugin config; every field is optional. */
export interface AutobiographicalCompactionConfig {
  /**
   * Directory root for the per-session Chronicle stores. Relative values
   * resolve against the session's project directory.
   */
  storeRoot?: string
  /**
   * Compile budget ceiling, overriding the adapter-reported context window
   * when set. Without it (and before the first routed request) the pass
   * skips until a routed window is known.
   */
  contextWindowTokens?: number
  /** Per-model operating ceilings, keyed by the session's routed model; beats the ~64k default. */
  contextWindowTokensByModel?: Record<string, number>
  /** Tokens reserved for the model's response inside the compile budget. */
  reserveTokens?: number
  /** Verbatim recent tail kept before anything folds; default 30000. */
  recentWindowTokens?: number
  /** Verbatim head pinned at the start of the session; default 4000. */
  headWindowTokens?: number
  /** Token ceiling for one mirrored message before the library splits it; default 10000. */
  maxMessageTokens?: number
  /** Approximate size of one L1 recollection chunk. */
  targetChunkTokens?: number
  /** How many same-level summaries merge into the next level. */
  mergeThreshold?: number
  /**
   * Generation budget pinned on every memory-formation call; unset leaves
   * the strategy's own request size. Raise it for long-reasoning models —
   * thinking shares this budget with the recollection text.
   */
  maxTokens?: number
  /** Frontier planning policy; `kv-stable` minimizes prompt-cache perturbation (default). */
  foldingStrategy?: 'kv-stable' | 'flat-profile' | 'oldest-first'
  /** Register the step-boundary folding listener. */
  auto?: boolean
}

/**
 * Runtime configuration: the windows carry the host's defaults; remaining
 * strategy knobs stay undefined when unset so the library's own defaults rule.
 */
export interface ResolvedAutobiographicalConfig {
  storeRoot: string
  contextWindowTokens?: number
  /** Per-model operating ceilings, keyed by the session's routed model; beats the ~64k default. */
  contextWindowTokensByModel?: Record<string, number>
  reserveTokens: number
  recentWindowTokens: number
  headWindowTokens: number
  maxMessageTokens: number
  targetChunkTokens?: number
  mergeThreshold?: number
  maxTokens?: number
  foldingStrategy: 'kv-stable' | 'flat-profile' | 'oldest-first'
  auto: boolean
}

/** The recollection a tick minted, carried so the chat can disclose it. */
export interface AutobioMemoryMint {
  id: string
  level: number
  content: string
  tokens: number
}

/** Strategy stats snapshot appended when one memory-formation tick changed them. */
export interface AutobioMemoryEventData {
  chunksTotal: number
  chunksCompressed: number
  compressionCount: number
  l1: number
  l2: number
  l3: number
  pendingMerges: number
  /** The bridge call that minted the recollection; absent on stats-only ticks. */
  attempt?: number
  /** Absent when the tick changed stats without minting a recollection. */
  memory?: AutobioMemoryMint
}

/** One streamed-text flush from an in-flight memory-formation call. */
export interface AutobioMemoryProgressEventData {
  /** Bridge call number within the session runtime; groups one call's flushes. */
  attempt: number
  /** Text streamed since the previous flush; empty on the terminal flush. */
  delta: string
  /** Present on the call's terminal flush, success or failure. */
  done?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one memory-formation tick that formed memory. */
    'autobio/memory': AutobioMemoryEventData
    /** Log-only live text stream of an in-flight memory-formation call. */
    'autobio/memory-progress': AutobioMemoryProgressEventData
  }
}
