/**
 * The coding-timer settings and activity face shared by the two timer
 * surfaces (the sidebar row's stats modal and the idle cover). The reactive
 * facts ride the inject `hooks` compartment as bare getSnapshot/subscribe
 * sources — the bound settings scope and the activity controller's snapshot
 * — and the mutations are user-gesture callbacks writing the gate and idle
 * fields through the scope.
 */
import type { SettingsScope, SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CODING_TIMER_GATE_FIELD, CODING_TIMER_IDLE_FIELD, DEFAULT_GATE, DEFAULT_IDLE_MINUTES,
  type CodingTimerSettings,
} from '../settings.ts'
import type { CodingActivitySnapshot } from './activity.ts'

/** Injected face seated on both coding-timer registrations. */
export interface CodingTimerSettingsFace {
  /** Bound settings scope and activity controller (hooks compartment sources). */
  hooks: {
    gate: SettingsScope<CodingTimerSettings>
    activity: SnapshotStore<CodingActivitySnapshot>
  }
  /**
   * Write the cover preference after a user gesture.
   * @param on - true to cover the UI after idle minutes, false to keep it visible.
   */
  setGate: (on: boolean) => void
  /**
   * Write the idle cover delay after a user gesture.
   * @param minutes - requested delay; resolved into the schema's bounds at
   *   the face, so this never carries a value the Host schema would reject.
   */
  setIdleMinutes: (minutes: number) => void
}

/**
 * Whether the idle cover may show for one scope snapshot: while the first
 * Host read is in flight nothing covers (a cover that might lift is worse
 * than a late cover); once resolved or unavailable the section decides, with
 * the schema default standing in for an absent namespace (memory mode).
 * @param snap - the bound scope's current snapshot.
 * @returns whether the cover preference allows covering.
 */
export function gateCovers(snap: SettingsScopeSnapshot<CodingTimerSettings>): boolean {
  return snap.status !== 'loading' && (snap.value?.[CODING_TIMER_GATE_FIELD] ?? DEFAULT_GATE)
}

/**
 * The idle cover delay for one scope snapshot, in minutes, with the schema
 * default standing in for an absent namespace or a pre-idle section.
 * @param snap - the bound scope's current snapshot.
 * @returns the idle delay in minutes.
 */
export function idleMinutesOf(snap: SettingsScopeSnapshot<CodingTimerSettings>): number {
  return snap.value?.[CODING_TIMER_IDLE_FIELD] ?? DEFAULT_IDLE_MINUTES
}
