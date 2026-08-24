/**
 * The coding timer's durable store: one active session marker plus the
 * completed-session history, persisted whole to localStorage through the
 * runtime engine's `persist` channel. The store IS the business state — the
 * timer is a personal browser surface with no host counterpart, so this is
 * the one place the data lives (the object-layer rule covers session and
 * connection state, not a client-only wellbeing timer).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** One completed coding stretch, epoch ms. `start <= end` by construction. */
export interface CodingSession {
  /** When Start Coding was pressed (epoch ms). */
  start: number
  /** When Stop Coding was pressed (epoch ms). */
  end: number
}

/**
 * Timer state: `activeSince` is the running session's start (epoch ms, null
 * when stopped); `sessions` is the append-only completed history.
 */
export interface CodingTimerState {
  /** Running session start (epoch ms), or null while stopped. */
  activeSince: number | null
  /** Completed sessions in start order. */
  sessions: CodingSession[]
}

/** Annotation twin of the actions literal (drift fails assignability at defineStore). */
type CodingTimerActions = {
  start: (draft: CodingTimerState, now: number) => void
  stop: (draft: CodingTimerState, now: number) => void
}

/** localStorage key for the whole-state JSON (root scope: no suffix). */
export const CODING_TIMER_PERSIST_KEY = 'dsh.coding-timer'

/**
 * Create the coding timer store handle. start/stop are idempotent in the
 * safe direction: starting a running timer and stopping a stopped one are
 * no-ops, so a double click never corrupts the history. A stop pressed
 * before its start (clock skew across reloads) records a zero-length
 * session rather than a negative one.
 * @returns the store handle (spec + identity + factory in one).
 */
export function createCodingTimerStore(): EngineStoreHandle<CodingTimerState, CodingTimerActions> {
  return defineStore({
    persist: CODING_TIMER_PERSIST_KEY,
    init: (): CodingTimerState => ({ activeSince: null, sessions: [] }),
    actions: {
      start: (d, now: number) => { if (d.activeSince === null) d.activeSince = now },
      stop: (d, now: number) => {
        if (d.activeSince === null) return
        d.sessions.push({ start: d.activeSince, end: Math.max(now, d.activeSince) })
        d.activeSince = null
      },
    },
  })
}

/** The registered handle type, for PropsStore derivation. */
export type CodingTimerStoreHandle = ReturnType<typeof createCodingTimerStore>
