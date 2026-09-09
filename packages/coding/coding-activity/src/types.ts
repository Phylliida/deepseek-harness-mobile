/**
 * Client-safe type surface of the coding-activity seam: the wire/store view
 * and the change event's Cordis declaration. Types only, so both the Host
 * gateway (`api-proxy` reads `ctx.codingActivity` through this face) and the
 * browser consumer (`ctx.remote.$on` takes its listener signature from the
 * Events merge below) compile against one declaration.
 *
 * @module @deepseek-ai/dsh-coding-activity/types
 */

import type { CodingActivityEntry, CodingActivityView } from './document.ts'

export type { CodingActivityEntry, CodingActivityView, CodingSpan } from './document.ts'

/**
 * The shared interaction log service (`ctx.codingActivity`): one append-only,
 * cross-device record of coding-activity spans. Implementations persist the
 * canonical document and emit `coding-activity/updated` after every
 * content-changing append.
 */
export interface CodingActivityLog {
  /**
   * Read the current canonical view.
   * @returns the document's revision and spans.
   */
  read(): Promise<CodingActivityView>
  /**
   * Fold one batch into the log and persist it. The append is atomic against
   * concurrent callers (in-process ordering plus the backing store's lock),
   * and span normalization makes concurrent devices' writes commute.
   * @param entry - stamps and/or whole spans to fold in.
   * @returns the view after the fold.
   */
  append(entry: CodingActivityEntry): Promise<CodingActivityView>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The cross-device coding-activity log, when the deployment mounts its provider. */
    codingActivity: CodingActivityLog
  }

  interface Events {
    /**
     * The coding-activity document changed. Emitted after the provider
     * persisted the append that produced `revision`; a no-op append (every
     * folded stamp already inside a span) still bumps nothing and emits
     * nothing. Revisions increase strictly per emission.
     * @param revision - the document's new revision.
     * @mode emit
     */
    'coding-activity/updated'(revision: number): void
  }
}
