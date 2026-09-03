/**
 * The focus gate: a frame-wide cover registered into the layout-declared
 * `shell.overlay` seat. While no coding session runs and the gate preference
 * (Host user settings, bound in apply) allows it, the cover hides the whole
 * app behind one calm panel — today's coded total and a Start Coding button —
 * so opening the GUI is a deliberate act. Starting the timer lifts the cover
 * (the app underneath stayed mounted, so nothing loses state); stopping from
 * the sidebar row brings it back. The layer's other occupants keep their
 * click-through contract — this cover is the documented exception, blocking
 * on purpose. The disable link is the escape hatch, and only renders when the
 * Host document accepts writes (a memory-mode remote browser would swallow
 * the click silently). The component also hosts the idle auto-stop watch
 * (useIdleAutoStop): mounted for the overlay seat's whole life, it stops a
 * forgotten timer after the configured idle minutes, which is what brings
 * this cover back.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' seat it
// declares) into this program so PropsRuntime<'shell.overlay'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CodingTimerSettingsFace } from './gate.ts'
import { gateCovers, idleMinutesOf } from './gate.ts'
import type { CodingTimerStoreHandle } from './store.ts'
import { addDays, dayStart, formatDuration, sumRangeMs } from './totals.ts'
import { useIdleAutoStop } from './useIdleAutoStop.ts'
import css from './CodingTimer.module.css'

/**
 * Full component props: the root-scope runtime share, the persisted timer
 * store share (same handle as the sidebar row), the settings face, and the
 * standard locale seat.
 */
export type CodingGateProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<CodingTimerStoreHandle>
  & InjectFace<CodingTimerSettingsFace>
  & PropsLocale<'coding-timer'>

/**
 * Render the gate cover for the shell.overlay seat, or nothing while a
 * session runs or the preference disables the gate. Stopped means static:
 * the total derives from the render instant and no interval runs at rest.
 * @param props - composed slot props (store + settings face + locale).
 * @returns the full-frame cover, or null when the UI stays visible.
 */
export function CodingGate({ useStore, actions, useGate, setGate, t }: CodingGateProps) {
  const activeSince = useStore(s => s.activeSince)
  const sessions = useStore(s => s.sessions)
  const covers = useGate(gateCovers)
  const writable = useGate(s => s.writable)
  const idleMinutes = useGate(idleMinutesOf)

  // The idle watch lives here rather than in the sidebar row: this seat is
  // mounted for the app's whole life regardless of sidebar geometry, and the
  // auto-stop it performs is what returns this cover.
  useIdleAutoStop(activeSince !== null, idleMinutes, actions.stop)

  if (activeSince !== null || !covers) return null

  const now = Date.now()
  const todayStart = dayStart(now)
  const todayTotal = sumRangeMs(sessions, null, now, todayStart, addDays(todayStart, 1))

  return (
    // role=dialog + aria-modal: the cover is a modal landmark — assistive tech
    // treats everything beneath it as inert, and tests locate the gate's
    // Start button apart from the sidebar row's identical toggle.
    <div className={css.gate} role="dialog" aria-modal="true" aria-label={t('start')}>
      <div className={css.gatePanel}>
        <span className={css.gateTodayLabel}>{t('gate.today')}</span>
        <span className={css.gateTodayValue}>{formatDuration(todayTotal, t)}</span>
        <Button
          variant="primary"
          className={css.gateStart}
          onClick={() => { actions.start(Date.now()) }}
        >
          {t('start')}
        </Button>
        {writable && (
          <button
            type="button"
            className={css.gateDisable}
            onClick={() => { setGate(false) }}
          >
            {t('gate.disable')}
          </button>
        )}
      </div>
    </div>
  )
}
