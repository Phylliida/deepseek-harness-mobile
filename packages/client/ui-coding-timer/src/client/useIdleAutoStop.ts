/**
 * Idle auto-stop hook for the coding timer: while a session runs, watch
 * window-level input activity and stop the timer after `idleMinutes` without
 * any. The stop is recorded AT the last activity, not at the fire instant —
 * a timer forgotten over lunch never bills the idle tail, and a fire delayed
 * by a sleeping device or a throttled background tab stays exact by the same
 * trim. Nothing is armed while stopped: the watch has zero listeners and
 * zero timers at rest.
 */
import { useEffect } from 'react'

/**
 * Input events that count as the user still being at the device: taps and
 * clicks (pointerdown), mouse/pen/touch drift (pointermove, plus the touch
 * pair for browsers without pointer events), typing, and scrolling (wheel
 * for the gesture, scroll for scrollbar/keyboard-driven scrolls).
 */
const ACTIVITY_EVENTS = [
  'pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel', 'scroll',
] as const

/**
 * Activity restamping granularity. pointermove alone floods during normal
 * use; one restamp per second is invisible against minute-scale timeouts and
 * keeps the armed timer aligned with the last stamped activity.
 */
const ACTIVITY_THROTTLE_MS = 1000

/**
 * Stop the running coding timer after `idleMinutes` without input activity.
 * Restamping activity re-arms the timeout; a timeout change re-runs the
 * effect, which restamps — changing the setting is itself activity. The
 * listener set rides window capture so scrolls inside nested scrollers are
 * heard (scroll does not bubble), all passive.
 * @param running - whether a coding session is active.
 * @param idleMinutes - idle timeout in minutes (settings-resolved).
 * @param stop - store stop action; called with the last-activity timestamp.
 * @returns nothing; the effect is the whole behavior.
 */
export function useIdleAutoStop(running: boolean, idleMinutes: number, stop: (at: number) => void): void {
  useEffect(() => {
    if (!running) return
    const timeoutMs = idleMinutes * 60_000
    // The session's own start is the first activity stamp, so a Start press
    // (or a persisted timer rehydrated across a reload) gets a full timeout.
    let lastActivity = Date.now()
    let lastStamp = lastActivity
    const onIdle = (): void => { stop(lastActivity) }
    let timer = window.setTimeout(onIdle, timeoutMs)
    const onActivity = (): void => {
      const now = Date.now()
      if (now - lastStamp < ACTIVITY_THROTTLE_MS) return
      lastStamp = now
      lastActivity = now
      window.clearTimeout(timer)
      timer = window.setTimeout(onIdle, timeoutMs)
    }
    const options: AddEventListenerOptions = { capture: true, passive: true }
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, options)
    return () => {
      window.clearTimeout(timer)
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, options)
    }
  }, [running, idleMinutes, stop])
}
