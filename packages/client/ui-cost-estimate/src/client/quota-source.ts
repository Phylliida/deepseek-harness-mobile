/** Kimi Code quota binding: a stable store refreshed by polling the `kimiQuota` Remote. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the payload vocabulary crosses the Host boundary through the Client assembly.
import type { KimiQuotaSnapshot } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Refresh cadence for the quota readout: one minute matches the rate limit
 * Kimi Code's own CLI applies to its quota fetch.
 */
export const KIMI_QUOTA_REFRESH_MS = 60_000

/** Structural comparison: an unchanged quota never replaces the published reference. */
function sameQuota(a: KimiQuotaSnapshot | null, b: KimiQuotaSnapshot | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Bind a quota fetcher into a standalone observable store: one immediate
 * refresh, then one per interval. `null` — an unavailable Remote, an
 * unconfigured credential, or an unreachable platform — publishes as-is, and
 * the readout hides the quota segment.
 * @param fetchCurrent - one `kimiQuota/current` call resolving the snapshot or null.
 * @param refreshMs - polling interval (default {@link KIMI_QUOTA_REFRESH_MS}).
 * @returns the quota store plus the timer disposer.
 */
export function bindKimiQuotaSource(
  fetchCurrent: () => Promise<KimiQuotaSnapshot | null>,
  refreshMs: number = KIMI_QUOTA_REFRESH_MS,
): { store: SnapshotStore<KimiQuotaSnapshot | null>; dispose: () => void } {
  const store = createSnapshotStore<KimiQuotaSnapshot | null>(null)
  const refresh = (): void => {
    void fetchCurrent().then((next) => {
      if (!sameQuota(store.getSnapshot(), next)) store.set(next)
      // A rejected fetch keeps the previous snapshot: one failed poll must not
      // flicker the segment off while the platform is briefly unreachable.
    }, () => undefined)
  }
  refresh()
  const timer = setInterval(refresh, refreshMs)
  return { store, dispose: () => { clearInterval(timer) } }
}
