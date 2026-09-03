/**
 * The sidebar coding-time tracker row: a Start/Stop Coding toggle that
 * times the running stretch, plus an info button opening the totals
 * calendar (CodingCalendar). Wide renders the labeled bar with a ticking
 * elapsed readout and the info affordance; the rail keeps one icon toggle
 * whose tooltip carries the same readout. State lives in the package's
 * persisted store (the declared PropsStore share); the ticking `now` and
 * the modal's open flag are component-private.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  IconPlayOutline16, IconQuestionOutline14, IconStopFill16, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.timer' hole it
// declares) into this program so PropsRuntime<'sidebar.timer'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CodingTimerSettingsFace } from './gate.ts'
import { gateCovers, idleMinutesOf } from './gate.ts'
import { IDLE_MINUTES_MAX, IDLE_MINUTES_MIN } from '../settings.ts'
import type { CodingTimerStoreHandle } from './store.ts'
import { formatClock } from './totals.ts'
import { CodingCalendar } from './CodingCalendar.tsx'
import css from './CodingTimer.module.css'

/**
 * Full component props: the sidebar's column state (owner share), the
 * persisted timer store share, the settings face (the stats modal carries
 * the gate toggle and the idle timeout), and the standard locale seat.
 */
export type CodingTimerProps =
  PropsRuntime<'sidebar.timer'>
  & PropsStore<CodingTimerStoreHandle>
  & InjectFace<CodingTimerSettingsFace>
  & PropsLocale<'coding-timer'>

/**
 * Render the coding timer row for the sidebar.timer seat.
 * @param props - composed slot props (owner wide flag + store + settings face + locale).
 * @returns the toggle row (wide) or icon toggle (rail), plus the stats modal.
 */
export function CodingTimer({ wide, useStore, actions, useGate, setGate, setIdleMinutes, t }: CodingTimerProps) {
  const activeSince = useStore(s => s.activeSince)
  const sessions = useStore(s => s.sessions)
  const gateOn = useGate(gateCovers)
  const idleMinutes = useGate(idleMinutesOf)
  const writable = useGate(s => s.writable)
  const [now, setNow] = useState(() => Date.now())
  const [statsOpen, setStatsOpen] = useState(false)

  // Tick once a second while a session runs so the elapsed readout and the
  // live calendar totals advance; stopped, nothing on screen changes with
  // time, so no timer runs at all.
  useEffect(() => {
    if (activeSince === null) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [activeSince])

  const running = activeSince !== null
  const toggle = (): void => {
    if (running) actions.stop(Date.now())
    else actions.start(Date.now())
  }

  if (!wide) {
    // Rail: one icon toggle; the tooltip carries label + elapsed readout.
    const label = running ? `${t('stop')} · ${formatClock(now - activeSince)}` : t('start')
    return (
      <Tooltip label={label} delayMs={500}>
        <button
          type="button"
          className={clsx(css.railToggle, running && css.running)}
          aria-label={label}
          aria-pressed={running}
          onClick={toggle}
        >
          {running ? <IconStopFill16 size={18} /> : <IconPlayOutline16 size={18} />}
          {running && <span className={css.railDot} aria-hidden="true" />}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className={css.row}>
      <button
        type="button"
        className={clsx(css.toggle, running && css.running)}
        aria-pressed={running}
        onClick={toggle}
      >
        {running ? <IconStopFill16 size={14} /> : <IconPlayOutline16 size={14} />}
        <span className={css.toggleLabel}>{running ? t('stop') : t('start')}</span>
        {running && <span className={css.elapsed}>{formatClock(now - activeSince)}</span>}
      </button>
      <Tooltip label={t('info')} delayMs={500}>
        <button
          type="button"
          className={css.infoButton}
          aria-label={t('info')}
          onClick={() => { setStatsOpen(true) }}
        >
          <IconQuestionOutline14 size={14} />
        </button>
      </Tooltip>
      <Modal
        open={statsOpen}
        onClose={() => { setStatsOpen(false) }}
        title={t('info')}
        closeLabel={t('close')}
      >
        <CodingCalendar sessions={sessions} activeSince={activeSince} now={now} t={t} />
        {/* The timer's settings rows (the cover's disable link is the gate's
            off ramp); hidden when the Host document cannot accept the write. */}
        {writable && (
          <div className={css.gateRow}>
            <span className={css.gateRowLabel}>{t('gate.toggle')}</span>
            <button
              type="button"
              className={clsx(css.gateRowToggle, gateOn && css.running)}
              aria-pressed={gateOn}
              onClick={() => { setGate(!gateOn) }}
            >
              {gateOn ? t('gate.on') : t('gate.off')}
            </button>
          </div>
        )}
        {writable && (
          <div className={css.gateRow}>
            <span className={css.gateRowLabel}>{t('idle.label')}</span>
            <span className={css.idleControl}>
              <input
                type="number"
                className={css.idleInput}
                min={IDLE_MINUTES_MIN}
                max={IDLE_MINUTES_MAX}
                step={1}
                value={idleMinutes}
                aria-label={t('idle.label')}
                onChange={(event) => {
                  const minutes = Number.parseInt(event.target.value, 10)
                  if (!Number.isNaN(minutes)) setIdleMinutes(minutes)
                }}
              />
              <span className={css.gateRowLabel}>{t('idle.minutes')}</span>
            </span>
          </div>
        )}
      </Modal>
    </div>
  )
}
