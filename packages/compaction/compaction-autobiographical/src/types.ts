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
   * The window the pass compiles against: the live context is held below
   * `min(routed window, this) − reserveTokens`, reached by folding aged history.
   * Default 65_536: models degrade well before their advertised window, so the
   * operating point stays there regardless of route. A configured value is the
   * ceiling itself rather than a floor under the route's own window.
   */
  operatingWindowTokens?: number
  /**
   * Tokens kept out of the live context for the model's response; default 8192.
   * The library subtracts them from the compile budget after the pass already
   * has, so the live ceiling is the window less twice this value — headroom that
   * also covers the system prompt and tool schemas the strategy never sees.
   */
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
  operatingWindowTokens: number
  reserveTokens: number
  auto: boolean
  strategy: AutobiographicalOptions
}

/**
 * What a recollection stands for, in log-seq terms.
 *
 * Two spans rather than one because they answer different questions and are not
 * the same interval. `covered` is the ground the recollection stands over, which
 * is what the planner compares a surface node against. `cited` is the interval its
 * fold node named, which is what a higher recollection's interval takes in — the
 * nodes that landed a child sit outside the interval that child cites, so nesting
 * on `covered` finds no children at all.
 */
export interface RecollectionRange {
  readonly covered: { readonly firstSeq: number; readonly lastSeq: number }
  readonly cited: { readonly firstSeq: number; readonly lastSeq: number }
  /**
   * The message ids the ground bottoms out in, in store-position order. A
   * recollection's `sourceRange` holds their ends, and a parent reads them to bound
   * its own range, so a level above resolves without walking the pyramid again.
   *
   * Written by seeding, which rebuilds the whole pyramid from one log and needs
   * every level's leaves to do it. A recollection minted live records its `covered`
   * span alone: its leaves are the span of the messages it resolved, which is what
   * its own `sourceRange` holds in the store.
   */
  readonly leaves?: readonly string[]
  /**
   * Log seq of the node a fold landed on, absent for a recollection whose fold
   * never landed. This is where a higher recollection's interval finds it: a
   * parent cites the child nodes it shadows, so membership is a question about
   * nodes rather than about the ground they stand for.
   */
  readonly at?: number
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

/**
 * Log-only record of one streamed-text flush from a memory-formation call: the
 * prose the chat's memory row follows while the call runs, and the terminal flush
 * that closes the attempt. The text is the call's own output and never becomes a
 * surface node, so this is the only place the live form of it is written down.
 */
export interface AutobiographicalMemoryProgressEventData {
  /** Bridge call number within the session runtime; groups one call's flushes. */
  attempt: number
  /** Text streamed since the previous flush; empty on the terminal flush. */
  delta: string
  /** Present on the call's terminal flush, success or failure. */
  done?: boolean
  /**
   * Why the call failed, on the terminal flush of one that did. A call can fail
   * before streaming any text, and this is what keeps such a request visible: the
   * row it settles reports the failure instead of an empty recollection.
   */
  error?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only record of one memory-formation tick that has news to report. */
    'autobio/memory': AutobiographicalMemoryEventData
    /** Live memory-formation text, and the terminal flush that closes the attempt. */
    'autobio/memory-progress': AutobiographicalMemoryProgressEventData
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
 *
 * @param text - the rendered text to size.
 * @returns the text's length divided by four and rounded up, so text of any
 *   length reports at least one token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
