/**
 * The sidebar coding-time tracker row: a live indicator of the shared
 * activity log — today's total, an Active/Idle state, and a ticking elapsed
 * readout while input is recent — plus an info button opening the totals
 * calendar (CodingCalendar). Wide renders the labeled bar with the readout
 * and the info affordance; the rail keeps one icon button whose tooltip
 * carries the same readout and whose click opens the same modal. Recording
 * itself needs no control: every interaction is a stamp on the shared log.
 * The ticking `now` and the modal's open flag are component-private.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import {
  IconPlayOutline16, IconQuestionOutline14, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.timer' hole it
// declares) into this program so PropsRuntime<'sidebar.timer'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CodingTimerSettingsFace } from './gate.ts'
import { gateCovers, idleMinutesOf } from './gate.ts'
import { displaySpans } from './bridging.ts'
import { IDLE_MINUTES_MAX, IDLE_MINUTES_MIN } from '../settings.ts'
import { addDays, dayStart, formatClock, formatDuration, sumRangeMs } from './totals.ts'
import { CodingCalendar } from './CodingCalendar.tsx'
import css from './CodingTimer.module.css'

/**
 * Full component props: the sidebar's column state (owner share), the
 * settings/activity face (the stats modal carries the cover toggle and the
 * idle delay), and the standard locale seat.
 */
export type CodingTimerProps =
  PropsRuntime<'sidebar.timer'>
  & InjectFace<CodingTimerSettingsFace>
  & PropsLocale<'coding-timer'>

/**
 * Render the coding timer row for the sidebar.timer seat.
 * @param props - composed slot props (owner wide flag + settings/activity face + locale).
 * @returns the live indicator row (wide), the icon button (rail), plus the stats modal.
 */
export function CodingTimer({ wide, useGate, useActivity, setGate, setIdleMinutes, t }: CodingTimerProps) {
  const gateOn = useGate(gateCovers)
  const idleMinutes = useGate(idleMinutesOf)
  const writable = useGate(s => s.writable)
  const activity = useActivity(s => s)
  const [now, setNow] = useState(() => Date.now())
  const [statsOpen, setStatsOpen] = useState(false)

  const display = displaySpans(activity, now)
  const todayStart = dayStart(now)
  const todayTotal = sumRangeMs(display.spans, todayStart, addDays(todayStart, 1))

  // The live tail bridges input to the render instant, so the elapsed
  // readout runs from the current run's first stamp.
  const liveSince = display.live ? display.spans[display.spans.length - 1]?.start ?? null : null

  // Tick once a second while input is recent so the elapsed readout and the
  // today's-total readout advance; while idle, the snapshot is the only
  // mover (a new interaction or another device's write), so no timer runs.
  useEffect(() => {
    if (!display.live) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [display.live])

  const statusLabel = display.live
    ? t('status.active')
    : t('status.idle')
  const elapsed = liveSince === null ? null : formatClock(now - liveSince)

  const modal = (
    <Modal
      open={statsOpen}
      onClose={() => { setStatsOpen(false) }}
      title={t('info')}
      closeLabel={t('close')}
    >
      <CodingCalendar spans={display.spans} now={now} t={t} />
      {/* The cover's settings rows; hidden when the Host document cannot
          accept the write. */}
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
                const minutes = Number.parseFloat(event.target.value)
                if (!Number.isNaN(minutes)) setIdleMinutes(minutes)
              }}
            />
            <span className={css.gateRowLabel}>{t('idle.minutes')}</span>
          </span>
        </div>
      )}
    </Modal>
  )

  if (!wide) {
    // Rail: one icon button; the tooltip carries state + today's total, the
    // dot marks the live state, and the click opens the stats modal.
    const label = display.live && elapsed !== null
      ? `${statusLabel} · ${elapsed}`
      : `${statusLabel} · ${t('today')} ${formatDuration(todayTotal, t)}`
    return (
      <>
        <Tooltip label={label} delayMs={500}>
          <button
            type="button"
            className={clsx(css.railToggle, display.live && css.running)}
            aria-label={label}
            aria-pressed={display.live}
            onClick={() => { setStatsOpen(true) }}
          >
            <IconPlayOutline16 size={18} />
            {display.live && <span className={css.railDot} aria-hidden="true" />}
          </button>
        </Tooltip>
        {modal}
      </>
    )
  }

  return (
    <div className={css.row}>
      <div className={css.toggle}>
        <span className={clsx(css.liveDot, display.live && css.running)} aria-hidden="true" />
        <span className={css.toggleLabel}>
          {statusLabel}
          {elapsed !== null && <span className={css.elapsed}>{elapsed}</span>}
        </span>
        <span className={css.elapsed}>{formatDuration(todayTotal, t)}</span>
      </div>
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
      {modal}
    </div>
  )
}
