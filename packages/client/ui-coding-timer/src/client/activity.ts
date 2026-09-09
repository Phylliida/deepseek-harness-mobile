/**
 * Wire-synced coding-activity controller: the browser half of the shared
 * interaction log. While any connected browser (this tab, the phone, the
 * second desktop) reports input, the Host document's canonical spans are the
 * totals every surface shows; this controller is the local contributor and
 * cache. It stamps window input (throttled), flushes batches over
 * `coding.write`, refreshes on the forwarded change event, and runs the
 * one-time legacy localStorage migration. The reactive fact components bind
 * (the inject `hooks.activity` seat) is the snapshot of that view plus the
 * locally pending stamps — local stamps project instantly, so the sidebar
 * row never waits a round-trip to light up.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { CodingActivityLogView, CodingSpanView, IApiClient } from '@deepseek-ai/dsh-client-connection/client'

/** Input events that count as the user being at the device. */
export const ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel', 'scroll',
] as const

/**
 * Restamping granularity. pointermove alone floods during normal use; one
 * stamp per second is invisible against the two-minute bridge and bounds the
 * write frequency.
 */
export const STAMP_THROTTLE_MS = 1000

/** Trailing delay before a batch of stamps crosses the wire. */
export const FLUSH_DELAY_MS = 3000

/** Retry cadence after a failed flush; the pending buffer survives until a write lands. */
export const FLUSH_RETRY_MS = 15_000

/** Pending-stamp bound: one hour of continuous throttled input, far above any realistic burst. */
export const PENDING_STAMPS_MAX = 3600

/** The legacy localStorage key of the retired per-browser timer (pre-log history migrates through it). */
export const LEGACY_TIMER_PERSIST_KEY = 'dsh.coding-timer'

/** Snapshot fed to the `hooks.activity` seat. */
export interface CodingActivitySnapshot {
  /** Load lifecycle: 'loading' until the first read resolves, 'unavailable' when the log is absent. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Revision of the view below (server counter); undefined before the first read. */
  revision: number | undefined
  /** Canonical spans as last read or acknowledged by a write. */
  spans: CodingSpanView[]
  /** Local stamps not yet acknowledged by the server (ascending epoch ms). */
  pendingStamps: number[]
  /** This tab's most recent input instant (epoch ms); the page load counts. */
  lastLocalActivity: number
}

/** The initial snapshot: page load is arrival, not yet coding activity. */
function initialSnapshot(): CodingActivitySnapshot {
  return {
    status: 'loading',
    revision: undefined,
    spans: [],
    pendingStamps: [],
    lastLocalActivity: Date.now(),
  }
}

/** One local input stamp, restamped at the throttle granularity. */
export interface CodingActivityController {
  /** The reactive view; stable references between publishes. */
  readonly source: SnapshotStore<CodingActivitySnapshot>
  /** Tear down listeners, timers, and reject no pending work. */
  dispose(): void
}

/** Narrow one legacy persisted timer state; anything malformed migrates nothing. */
function readLegacyTimer(): { activeSince: number | null; sessions: { start: number; end: number }[] } | undefined {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(LEGACY_TIMER_PERSIST_KEY)
  } catch (storageError) {
    // Storage can throw under privacy modes; a failed read must not block boot.
    console.warn('coding-timer: legacy migration could not read localStorage:', storageError)
    return undefined
  }
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_parseError) {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const sessions = Array.isArray(record.sessions)
    ? record.sessions.filter((session): session is { start: number; end: number } =>
      typeof session === 'object' && session !== null
      && typeof (session as { start?: unknown }).start === 'number'
      && typeof (session as { end?: unknown }).end === 'number')
    : []
  return {
    activeSince: typeof record.activeSince === 'number' ? record.activeSince : null,
    sessions,
  }
}

/**
 * Drive the shared log: stamp input, flush batches, refresh on forwarded
 * changes, and migrate the retired localStorage history once. Wire failures
 * keep every stamp pending — activity recording eventually lands when the
 * connection recovers, and no retry timer runs while the buffer is empty.
 * @param api - the connection's API client.
 * @param onRemoteChange - subscribed-by-caller event subscription handle.
 * @returns the controller; subscribe through `source`.
 */
export function createCodingActivityController(
  api: Pick<IApiClient, 'coding'>,
  onRemoteChange: (listener: () => void) => () => void,
): CodingActivityController {
  const store: SnapshotStore<CodingActivitySnapshot> = createSnapshotStore(initialSnapshot())
  let disposed = false
  let flushTimer: number | undefined
  let retryTimer: number | undefined
  let flight = false

  /** Replace the acknowledged view when it is newer than the cached one. */
  function accept(view: CodingActivityLogView): void {
    const snapshot = store.getSnapshot()
    if (snapshot.revision !== undefined && view.revision < snapshot.revision) return
    store.update((draft) => {
      draft.status = 'ready'
      draft.revision = view.revision
      draft.spans = view.spans
    })
  }

  /** First-read + remote-event refresh; failures mark the log unavailable only while still unloaded. */
  async function refresh(): Promise<void> {
    let response
    try {
      response = await api.coding.read({})
    } catch (transportError) {
      console.warn('coding-timer: activity read failed:', transportError)
      return
    }
    if (disposed || !response.result.ok) {
      if (!disposed && store.getSnapshot().status === 'loading') {
        store.update((draft) => { draft.status = 'unavailable' })
      }
      return
    }
    accept(response.result.value)
    await migrateLegacy()
  }

  /** Move the retired per-browser history into the shared log, once. */
  async function migrateLegacy(): Promise<void> {
    const legacy = readLegacyTimer()
    if (legacy === undefined || (legacy.sessions.length === 0 && legacy.activeSince === null)) return
    const spans = [
      ...legacy.sessions,
      // A running timer at migration time counts up to the migration instant;
      // the passive recorder takes over from here.
      ...legacy.activeSince === null ? [] : [{ start: legacy.activeSince, end: Date.now() }],
    ]
    let response
    try {
      response = await api.coding.write({ spans })
    } catch (transportError) {
      console.warn('coding-timer: legacy migration write failed:', transportError)
      return
    }
    if (!response.result.ok) return
    accept(response.result.value)
    try {
      window.localStorage.removeItem(LEGACY_TIMER_PERSIST_KEY)
    } catch (storageError) {
      console.warn('coding-timer: legacy migration could not clear localStorage:', storageError)
    }
  }

  /** POST the pending buffer; a newer revision in the response is adopted. */
  async function flush(): Promise<void> {
    if (flight || disposed) return
    const batch = store.getSnapshot().pendingStamps
    if (batch.length === 0) return
    flight = true
    let response
    try {
      response = await api.coding.write({ stamps: batch })
    } catch (transportError) {
      flight = false
      console.warn('coding-timer: activity write failed:', transportError)
      scheduleRetry()
      return
    }
    flight = false
    if (disposed) return
    if (!response.result.ok) {
      scheduleRetry()
      return
    }
    accept(response.result.value)
    store.update((draft) => { draft.pendingStamps = draft.pendingStamps.slice(batch.length) })
    // Stamps that arrived during the flight queue the next batch.
    if (store.getSnapshot().pendingStamps.length > 0) scheduleFlush()
  }

  /** Arm the trailing flush, once per buffer. */
  function scheduleFlush(): void {
    if (flushTimer !== undefined || disposed) return
    flushTimer = window.setTimeout(() => {
      flushTimer = undefined
      void flush()
    }, FLUSH_DELAY_MS)
  }

  /** Arm one retry after a failed flush. */
  function scheduleRetry(): void {
    if (retryTimer !== undefined || disposed) return
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      void flush()
    }, FLUSH_RETRY_MS)
  }

  /** The throttle's own clock, independent of the gate's arrival stamp. */
  let lastStamped = Number.NEGATIVE_INFINITY

  /** One throttled input stamp: restamp the snapshot and queue the wire batch. */
  function stamp(now: number): void {
    if (now - lastStamped < STAMP_THROTTLE_MS) {
      store.update((draft) => { draft.lastLocalActivity = now })
      // The throttle stretches a run's tail by at most one window; when a
      // stamp is still pending, keep the latest instant of the window.
      const last = store.getSnapshot().pendingStamps.at(-1)
      if (last !== undefined) {
        store.update((draft) => { draft.pendingStamps[draft.pendingStamps.length - 1] = now })
      }
      return
    }
    lastStamped = now
    store.update((draft) => {
      draft.lastLocalActivity = now
      if (draft.pendingStamps.length < PENDING_STAMPS_MAX) draft.pendingStamps.push(now)
    })
    scheduleFlush()
  }

  const onActivity = (): void => { stamp(Date.now()) }
  const options: AddEventListenerOptions = { capture: true, passive: true }
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, options)
  const onVisibility = (): void => { if (document.visibilityState === 'hidden') void flush() }
  const onPageHide = (): void => { void flush() }
  window.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  const unsubscribeRemote = onRemoteChange(() => { void refresh() })
  void refresh()

  return {
    source: store,
    dispose() {
      disposed = true
      window.clearTimeout(flushTimer)
      window.clearTimeout(retryTimer)
      unsubscribeRemote()
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, options)
      window.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    },
  }
}
