/**
 * The idle cover: a frame-wide layer registered into the layout-declared
 * `shell.overlay` seat. After `idleMinutes` without input in this tab — and
 * only while the cover preference (Host user settings, bound in apply)
 * allows it — the cover hides the whole app behind one calm panel showing
 * today's coded total, so returning to the GUI is a deliberate act rather
 * than an invitation to keep grazing. ANY interaction lifts it: the activity
 * recorder listens at window capture, so a pointer move over the cover
 * restamps the snapshot and the cover leaves. The layer's other occupants
 * keep their click-through contract — this cover is the documented
 * exception, blocking on purpose. The disable link is the escape hatch, and
 * only renders when the Host document accepts writes (a memory-mode remote
 * browser would swallow the click silently). While the activity log is
 * still loading or unavailable, nothing covers: a cover that might lift is
 * worse than a late cover.
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' seat it
// declares) into this program so PropsRuntime<'shell.overlay'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { CodingTimerSettingsFace } from './gate.ts'
import { gateCovers, idleMinutesOf } from './gate.ts'
import { displaySpans } from './bridging.ts'
import { addDays, dayStart, formatDuration, sumRangeMs } from './totals.ts'
import css from './CodingTimer.module.css'

/**
 * Full component props: the root-scope runtime share, the settings/activity
 * face, and the standard locale seat.
 */
export type CodingGateProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<CodingTimerSettingsFace>
  & PropsLocale<'coding-timer'>

/** Milliseconds per minute, factored out of the cover delay math. */
const MINUTE_MS = 60_000

/**
 * Render the idle cover for the shell.overlay seat, or nothing while input
 * is recent, the preference disables the cover, or the activity log has not
 * answered yet.
 * @param props - composed slot props (settings/activity face + locale).
 * @returns the full-frame cover, or null while the UI stays visible.
 */
export function CodingGate({ useGate, useActivity, setGate, t }: CodingGateProps) {
  const covers = useGate(gateCovers)
  const writable = useGate(s => s.writable)
  const idleMinutes = useGate(idleMinutesOf)
  const activity = useActivity(s => s)
  const [now, setNow] = useState(() => Date.now())

  const idleMs = idleMinutes * MINUTE_MS
  const ready = activity.status === 'ready'
  const covered = covers && ready && now - activity.lastLocalActivity >= idleMs

  // Uncovered and approaching the idle boundary: arm one timer to the exact
  // boundary. Covered, nothing times — the next interaction's stamp is the
  // only way out, and it publishes through the snapshot.
  useEffect(() => {
    if (covered || !covers || !ready) return
    const boundary = activity.lastLocalActivity + idleMs
    const timer = window.setTimeout(
      () => { setNow(Date.now()) },
      Math.max(boundary - now, 250),
    )
    return () => { window.clearTimeout(timer) }
  }, [covered, covers, ready, activity.lastLocalActivity, idleMs, now])

  if (!covered) return null

  const todayStart = dayStart(now)
  const todayTotal = sumRangeMs(displaySpans(activity, now).spans, todayStart, addDays(todayStart, 1))

  return (
    // role=dialog + aria-modal: the cover is a modal landmark — assistive tech
    // treats everything beneath it as inert, and tests locate the cover apart
    // from the sidebar row.
    <div className={css.gate} role="dialog" aria-modal="true" aria-label={t('gate.today')}>
      <div className={css.gatePanel}>
        <span className={css.gateTodayLabel}>{t('gate.today')}</span>
        <span className={css.gateTodayValue}>{formatDuration(todayTotal, t)}</span>
        <span className={css.gateTodayLabel}>{t('gate.hint')}</span>
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
