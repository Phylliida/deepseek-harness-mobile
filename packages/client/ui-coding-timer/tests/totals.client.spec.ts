/**
 * Pure calendar/total math: local-midnight splits, Monday weeks, month grid
 * geometry, and the duration formats. Deterministic via explicit epoch-ms
 * inputs constructed from local Date fields (the semantics under test are
 * local-time by design).
 */
import { describe, expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import type { CodingSession } from '../src/client/store.ts'
import {
  addDays, buildMonthGrid, dayStart, formatClock, formatDuration, shiftMonth, splitDuration, sumRangeMs, weekStart,
} from '../src/client/totals.ts'

/** English-dictionary translate stub with {name} interpolation. */
const t = (key: string, params?: Record<string, unknown>): string => {
  let s = (en as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** Local wall-clock constructor keeping expectations readable. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

describe('dayStart / addDays / weekStart', () => {
  it('floors to local midnight and steps whole local days', () => {
    const noon = at(2026, 3, 15, 12, 30)
    expect(dayStart(noon)).toBe(at(2026, 3, 15))
    // Stepping preserves the time of day; day ranges floor first.
    expect(addDays(dayStart(noon), 1)).toBe(at(2026, 3, 16))
    expect(addDays(dayStart(noon), -1)).toBe(at(2026, 3, 14))
    // Month underflow rolls into the previous month.
    expect(addDays(at(2026, 3, 1), -1)).toBe(at(2026, 2, 28))
  })

  it('finds the ISO Monday of the containing week, Sunday included', () => {
    // 2026-03-16 is a Monday; 2026-03-22 its Sunday.
    expect(weekStart(at(2026, 3, 16, 9))).toBe(at(2026, 3, 16))
    expect(weekStart(at(2026, 3, 22, 23))).toBe(at(2026, 3, 16))
    expect(weekStart(at(2026, 3, 15, 12))).toBe(at(2026, 3, 9))
  })
})

describe('sumRangeMs', () => {
  const sessions: CodingSession[] = [
    { start: at(2026, 3, 16, 9), end: at(2026, 3, 16, 11) }, // 2h same day
    { start: at(2026, 3, 16, 23), end: at(2026, 3, 17, 1) }, // 2h across midnight
  ]

  it('clips completed sessions to the range', () => {
    expect(sumRangeMs(sessions, null, 0, at(2026, 3, 16), at(2026, 3, 17)))
      .toBe(2 * 3_600_000 + 3_600_000)
    expect(sumRangeMs(sessions, null, 0, at(2026, 3, 17), at(2026, 3, 18))).toBe(3_600_000)
    expect(sumRangeMs(sessions, null, 0, at(2026, 3, 18), at(2026, 3, 19))).toBe(0)
  })

  it('counts the live session up to now', () => {
    const now = at(2026, 3, 18, 12)
    expect(sumRangeMs([], at(2026, 3, 18, 10), now, at(2026, 3, 18), at(2026, 3, 19)))
      .toBe(2 * 3_600_000)
    // A range before the live session contributes nothing.
    expect(sumRangeMs([], at(2026, 3, 18, 10), now, at(2026, 3, 17), at(2026, 3, 18))).toBe(0)
  })
})

describe('buildMonthGrid', () => {
  it('lays March 2026 out Monday-first with borrowed adjacent-month days', () => {
    // 2026-03-01 is a Sunday: the first row borrows six February days.
    const weeks = buildMonthGrid(2026, 2)
    expect(weeks.every(w => w.length === 7)).toBe(true)
    expect(weeks[0]![0]).toEqual({ dayMs: at(2026, 2, 23), inMonth: false })
    expect(weeks[0]![6]).toEqual({ dayMs: at(2026, 3, 1), inMonth: true })
    const last = weeks[weeks.length - 1]!
    expect(last[6]!.dayMs).toBe(at(2026, 4, 5))
    expect(last[6]!.inMonth).toBe(false)
    // Every real March day appears exactly once as an in-month cell.
    const inMonth = weeks.flat().filter(c => c.inMonth)
    expect(inMonth).toHaveLength(31)
  })

  it('starts with a full row when the first is a Monday', () => {
    // 2026-06-01 is a Monday.
    const weeks = buildMonthGrid(2026, 5)
    expect(weeks[0]![0]).toEqual({ dayMs: at(2026, 6, 1), inMonth: true })
  })
})

describe('shiftMonth', () => {
  it('moves across year boundaries', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
    expect(shiftMonth(2025, 11, 1)).toEqual({ year: 2026, month: 0 })
  })
})

describe('formats', () => {
  it('formats the ticking clock as h:mm:ss and never negative', () => {
    expect(formatClock(0)).toBe('0:00:00')
    expect(formatClock(59_000)).toBe('0:00:59')
    expect(formatClock(3_600_000 + 62_000)).toBe('1:01:02')
    expect(formatClock(-5)).toBe('0:00:00')
  })

  it('formats localized durations as zero, minutes-only, or hours+minutes', () => {
    expect(formatDuration(0, t)).toBe('0m')
    expect(formatDuration(59_999, t)).toBe('0m')
    expect(formatDuration(45 * 60_000, t)).toBe('45m')
    expect(formatDuration(150 * 60_000, t)).toBe('2h 30m')
  })

  it('splits totals into whole hours and remaining minutes, truncating', () => {
    expect(splitDuration(0)).toEqual({ hours: 0, minutes: 0 })
    expect(splitDuration(59_999)).toEqual({ hours: 0, minutes: 0 })
    expect(splitDuration(90 * 60_000 + 59_000)).toEqual({ hours: 1, minutes: 30 })
  })
})
