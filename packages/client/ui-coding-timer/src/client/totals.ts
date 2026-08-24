/**
 * Pure calendar/total math for the coding timer, kept component-free so the
 * day-boundary semantics (local midnight splits, Monday weeks) are testable
 * without render machinery. Every total derives from the same overlap
 * primitive, so the button readout, the day cells, and the week column can
 * never disagree. Day stepping goes through Date arithmetic, not fixed
 * millisecond strides, so DST transitions never shift a cell off midnight.
 */
import type { CodingSession } from './store.ts'

/** Milliseconds in one minute. */
export const MINUTE_MS = 60_000

/**
 * Local midnight at or before `ms`.
 * @param ms - epoch milliseconds.
 * @returns local midnight of the containing day (epoch ms).
 */
export function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * The same local time `n` signed days after `dayMs` (DST-safe).
 * @param dayMs - epoch milliseconds inside the source day.
 * @param n - signed day count.
 * @returns epoch milliseconds `n` local days later.
 */
export function addDays(dayMs: number, n: number): number {
  const d = new Date(dayMs)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/**
 * Local Monday (ISO week start) at or before `ms`. Date#getDay yields 0 for
 * Sunday; the wrap maps it to the Monday six days back.
 * @param ms - epoch milliseconds.
 * @returns local midnight of the containing week's Monday (epoch ms).
 */
export function weekStart(ms: number): number {
  const start = dayStart(ms)
  return addDays(start, -((new Date(start).getDay() + 6) % 7))
}

/**
 * Total coding ms overlapping `[rangeStart, rangeEnd)`: completed sessions
 * clipped to the range plus the live session (activeSince..now) when one is
 * running. A stretch crossing midnight splits across both days, which is the
 * point of the tracker — late-night coding counts against the day it
 * happened on.
 * @param sessions - completed session history (epoch ms pairs).
 * @param activeSince - running session start (epoch ms), or null while stopped.
 * @param now - the instant the live session counts up to (epoch ms).
 * @param rangeStart - inclusive range start (epoch ms).
 * @param rangeEnd - exclusive range end (epoch ms).
 * @returns total coding milliseconds inside the range.
 */
export function sumRangeMs(
  sessions: readonly CodingSession[],
  activeSince: number | null,
  now: number,
  rangeStart: number,
  rangeEnd: number,
): number {
  let total = 0
  for (const s of sessions) {
    total += Math.max(0, Math.min(s.end, rangeEnd) - Math.max(s.start, rangeStart))
  }
  if (activeSince !== null) {
    total += Math.max(0, Math.min(now, rangeEnd) - Math.max(activeSince, rangeStart))
  }
  return total
}

/** One calendar cell: the day's local start and whether it belongs to the viewed month. */
export interface MonthCell {
  /** Local midnight of the cell's day (epoch ms). */
  dayMs: number
  /** False for the leading/trailing days borrowed from adjacent months. */
  inMonth: boolean
}

/**
 * Build the viewed month's grid as Monday-first week rows of seven cells.
 * Rows always run Monday through Sunday (borrowed adjacent-month days
 * included) so the trailing week-total column counts complete weeks.
 * @param year - full year of the viewed month.
 * @param month - zero-based month of the viewed month.
 * @returns week rows, each exactly seven cells.
 */
export function buildMonthGrid(year: number, month: number): MonthCell[][] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - lead)
  const weeks: MonthCell[][] = []
  let cursor = gridStart
  for (;;) {
    const week: MonthCell[] = []
    for (let i = 0; i < 7; i++) {
      const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + i)
      week.push({ dayMs: day.getTime(), inMonth: day.getMonth() === month })
    }
    weeks.push(week)
    const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7)
    if (next.getMonth() !== month) break
    cursor = next
  }
  return weeks
}

/**
 * Shift a `{year, month}` pair by signed months (calendar navigation).
 * @param year - full year of the viewed month.
 * @param month - zero-based month of the viewed month.
 * @param delta - signed month count.
 * @returns the shifted `{year, month}` pair.
 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}

/**
 * Format a running elapsed span as `h:mm:ss` for the toggle button — a
 * ticking clock, so the fixed-width numeric form reads at a glance in both
 * locales.
 * @param ms - elapsed milliseconds (negative clamps to zero).
 * @returns the `h:mm:ss` readout.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${hours}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * Decompose a total into whole hours and remaining minutes for the localized
 * `duration.*` templates. Rounds down to the minute; sub-minute totals stay
 * zero rather than rounding up (the calendar shows earned time).
 * @param ms - total milliseconds.
 * @returns whole hours and remaining minutes.
 */
export function splitDuration(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.floor(ms / MINUTE_MS)
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 }
}
