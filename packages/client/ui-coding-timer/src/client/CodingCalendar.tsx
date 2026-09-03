/**
 * Coding-time totals calendar: the modal body behind the timer row's info
 * button. A Monday-first month grid where each day cell shows that day's
 * coding total and each week row ends in its week total, plus the today /
 * this-week summary on top. All totals come from totals.ts's single overlap
 * primitive; navigation is component-private viewing state.
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { IconChevronLeftOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodingSession } from './store.ts'
import {
  addDays, buildMonthGrid, dayStart, formatDuration, MINUTE_MS, shiftMonth, sumRangeMs, weekStart,
} from './totals.ts'
import css from './CodingTimer.module.css'

/**
 * Render the totals calendar for the viewed month.
 * @param props.sessions - completed session history (store state).
 * @param props.activeSince - running session start, or null while stopped.
 * @param props.now - render instant; the live session counts up to it.
 * @param props.t - the coding-timer namespace translate seat.
 * @returns the summary strip plus the month grid.
 */
export function CodingCalendar({ sessions, activeSince, now, t }: {
  sessions: readonly CodingSession[]
  activeSince: number | null
  now: number
  t: TranslateNS<'coding-timer'>
}) {
  const todayMs = dayStart(now)
  const [view, setView] = useState(() => ({ year: new Date(now).getFullYear(), month: new Date(now).getMonth() }))

  // Derived data is a pure function over store slices + the viewed month.
  const weeks = useMemo(() => buildMonthGrid(view.year, view.month), [view.year, view.month])
  const todayTotal = sumRangeMs(sessions, activeSince, now, todayMs, addDays(todayMs, 1))
  const thisWeekStart = weekStart(now)
  const weekTotal = sumRangeMs(sessions, activeSince, now, thisWeekStart, addDays(thisWeekStart, 7))

  return (
    <div className={css.calendar}>
      <div className={css.summary}>
        <div className={css.summaryItem}>
          <span className={css.summaryLabel}>{t('today')}</span>
          <span className={css.summaryValue}>{formatDuration(todayTotal, t)}</span>
        </div>
        <div className={css.summaryItem}>
          <span className={css.summaryLabel}>{t('thisWeek')}</span>
          <span className={css.summaryValue}>{formatDuration(weekTotal, t)}</span>
        </div>
      </div>

      <div className={css.monthHead}>
        <button
          type="button"
          className={css.monthNav}
          aria-label={t('month.prev')}
          onClick={() => { setView(v => shiftMonth(v.year, v.month, -1)) }}
        >
          <IconChevronLeftOutline14 size={14} />
        </button>
        <span className={css.monthTitle}>{t('month.title', { year: view.year, month: view.month + 1 })}</span>
        <button
          type="button"
          className={css.monthNav}
          aria-label={t('month.next')}
          onClick={() => { setView(v => shiftMonth(v.year, v.month, 1)) }}
        >
          <IconChevronRightOutline14 size={14} />
        </button>
      </div>

      <div className={css.grid} role="table" aria-label={t('info')}>
        <div className={css.gridRow} role="row">
          {([1, 2, 3, 4, 5, 6, 7] as const).map(d => (
            <span key={d} className={css.weekday} role="columnheader">{t(`wd.${d}`)}</span>
          ))}
          <span className={clsx(css.weekday, css.weekTotalHead)} role="columnheader">{t('week.total')}</span>
        </div>
        {weeks.map((week) => {
          // buildMonthGrid's rows are seven cells by contract; the fallback
          // keeps the no-non-null-assertion rule without a blind `!`.
          const firstCell = week[0]
          /* v8 ignore next -- unreachable: buildMonthGrid emits full rows. */
          if (firstCell === undefined) return null
          const start = firstCell.dayMs
          const total = sumRangeMs(sessions, activeSince, now, start, addDays(start, 7))
          return (
            <div key={start} className={css.gridRow} role="row">
              {week.map((cell) => {
                const dayTotal = sumRangeMs(sessions, activeSince, now, cell.dayMs, addDays(cell.dayMs, 1))
                return (
                  <span
                    key={cell.dayMs}
                    role="cell"
                    className={clsx(
                      css.day,
                      !cell.inMonth && css.dayOutside,
                      cell.dayMs === todayMs && css.dayToday,
                      dayTotal >= MINUTE_MS && css.dayHasTime,
                    )}
                  >
                    <span className={css.dayNumber}>{new Date(cell.dayMs).getDate()}</span>
                    {dayTotal >= MINUTE_MS && <span className={css.dayTotal}>{formatDuration(dayTotal, t)}</span>}
                  </span>
                )
              })}
              <span className={css.weekTotal} role="cell">{formatDuration(total, t)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
