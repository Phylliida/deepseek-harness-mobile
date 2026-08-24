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
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.timer' hole it
// declares) into this program so PropsRuntime<'sidebar.timer'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CodingTimerStoreHandle } from './store.ts'
import { formatClock } from './totals.ts'
import { CodingCalendar } from './CodingCalendar.tsx'
import css from './CodingTimer.module.css'

/**
 * Full component props: the sidebar's column state (owner share), the
 * persisted timer store share, and the standard locale seat. No inject face
 * — the timer is fully client-local.
 */
export type CodingTimerProps =
  PropsRuntime<'sidebar.timer'>
  & PropsStore<CodingTimerStoreHandle>
  & PropsLocale<'coding-timer'>

/**
 * Render the coding timer row for the sidebar.timer seat.
 * @param props - composed slot props (owner wide flag + store + locale).
 * @returns the toggle row (wide) or icon toggle (rail), plus the stats modal.
 */
export function CodingTimer({ wide, useStore, actions, t }: CodingTimerProps) {
  const activeSince = useStore(s => s.activeSince)
  const sessions = useStore(s => s.sessions)
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
      </Modal>
    </div>
  )
}
