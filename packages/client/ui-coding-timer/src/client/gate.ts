/**
 * The coding-timer settings face shared by the two timer surfaces (the
 * sidebar row's stats modal and the shell-wide gate cover). The reactive
 * fact rides the inject `hooks` compartment as the bound settings scope
 * itself — a bare getSnapshot/subscribe source — and the mutations are
 * user-gesture callbacks writing the gate and idle fields through the scope.
 */
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CODING_TIMER_GATE_FIELD, CODING_TIMER_IDLE_FIELD, DEFAULT_GATE, DEFAULT_IDLE_MINUTES,
  type CodingTimerSettings,
} from '../settings.ts'

/** Injected face seated on both coding-timer registrations. */
export interface CodingTimerSettingsFace {
  /** Bound `coding-timer` settings scope (hooks compartment source). */
  hooks: { gate: SettingsScope<CodingTimerSettings> }
  /**
   * Write the gate preference after a user gesture.
   * @param on - true to cover the UI while stopped, false to keep it visible.
   */
  setGate: (on: boolean) => void
  /**
   * Write the idle auto-stop timeout after a user gesture.
   * @param minutes - requested timeout; resolved into the schema's bounds at
   *   the face, so this never carries a value the Host schema would reject.
   */
  setIdleMinutes: (minutes: number) => void
}

/**
 * Whether the gate cover should show for one scope snapshot: while the first
 * Host read is in flight nothing covers (a cover that might lift is worse
 * than a late cover); once resolved or unavailable the section decides, with
 * the schema default standing in for an absent namespace (memory mode).
 * @param snap - the bound scope's current snapshot.
 * @returns whether a stopped timer covers the UI.
 */
export function gateCovers(snap: SettingsScopeSnapshot<CodingTimerSettings>): boolean {
  return snap.status !== 'loading' && (snap.value?.[CODING_TIMER_GATE_FIELD] ?? DEFAULT_GATE)
}

/**
 * The idle auto-stop timeout for one scope snapshot, in minutes, with the
 * schema default standing in for an absent namespace or a pre-idle section.
 * @param snap - the bound scope's current snapshot.
 * @returns the idle timeout in minutes.
 */
export function idleMinutesOf(snap: SettingsScopeSnapshot<CodingTimerSettings>): number {
  return snap.value?.[CODING_TIMER_IDLE_FIELD] ?? DEFAULT_IDLE_MINUTES
}
