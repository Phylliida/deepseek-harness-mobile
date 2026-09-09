// @vitest-environment jsdom
/**
 * CodingTimer props-direct spec: settings and activity snapshots drive the
 * row, and the translate seat is a stub over the shipped en dictionary.
 * Behavior under test: the live indicator and today's total derive from the
 * display projection, the elapsed readout ticks while input is recent, the
 * info button opens the totals calendar (today/this-week summary, day cells,
 * week column, month navigation), the settings rows write through the face,
 * and the rail renders the icon button. The fake clock is 2026-03-18 (a
 * Wednesday) so calendar expectations are exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CodingTimer } from '../src/client/CodingTimer.tsx'
import type { CodingTimerProps } from '../src/client/CodingTimer.tsx'
import type { CodingActivitySnapshot } from '../src/client/activity.ts'
import { en } from '../src/client/locales.ts'
import type { CodingTimerSettings } from '../src/settings.ts'

/** Local wall-clock constructor keeping seed data readable. */
function at(month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(2026, month - 1, day, hour, minute, second).getTime()
}

/** English-dictionary translate stub with {name} interpolation. */
const t: CodingTimerProps['t'] = (key: string, params?: Record<string, unknown>) => {
  let s = (en as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** Test-local selector hook over a framework-neutral source. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

// The timer never reads the global hooks, but they ride the standard props
// share; stub them as never-called functions.
const neverHook = (() => { throw new Error('timer must not read global hooks') }) as never

/** One ready settings snapshot; only the fields under test vary. */
function gateSnap(over: Partial<SettingsScopeSnapshot<CodingTimerSettings>> = {}): SettingsScopeSnapshot<CodingTimerSettings> {
  return {
    status: 'ready',
    value: { gate: true, idleMinutes: 2 },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
    ...over,
  }
}

/** One ready activity snapshot; no spans and no input by default. */
function activitySnap(over: Partial<CodingActivitySnapshot> = {}): CodingActivitySnapshot {
  return {
    status: 'ready',
    revision: 0,
    spans: [],
    pendingStamps: [],
    lastLocalActivity: at(3, 18, 11, 0),
    ...over,
  }
}

/** Mount the row against the given snapshots. */
function mount(wide: boolean, gate = gateSnap(), activity = activitySnap()) {
  const settingsSource = { subscribe: () => () => {}, getSnapshot: () => gate }
  const activitySource = { subscribe: () => () => {}, getSnapshot: () => activity }
  const setGate = vi.fn()
  const setIdleMinutes = vi.fn()
  const utils = render(
    <CodingTimer
      wide={wide}
      useSessions={neverHook} useWorkspaces={neverHook}
      useGate={hookOf(settingsSource)} useActivity={hookOf(activitySource)}
      setGate={setGate} setIdleMinutes={setIdleMinutes} t={t}
    />,
  )
  return { setGate, setIdleMinutes, ...utils }
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(at(3, 18, 12))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('CodingTimer wide row', () => {
  it('shows Idle and today\'s total while input is stale', () => {
    mount(true, gateSnap(), activitySnap({ spans: [{ start: at(3, 18, 9), end: at(3, 18, 9, 45) }] }))
    expect(screen.getByText('Idle')).toBeTruthy()
    expect(screen.getByText('45m')).toBeTruthy()
    // No ticking readout while idle.
    expect(screen.queryByText(/\d+:\d\d:\d\d/)).toBeNull()
  })

  it('shows Active with a ticking elapsed readout while input is recent', () => {
    mount(true, gateSnap(), activitySnap({
      spans: [{ start: at(3, 18, 11, 55), end: at(3, 18, 11, 59, 30) }],
      lastLocalActivity: at(3, 18, 11, 59, 30),
    }))
    expect(screen.getByText('Active')).toBeTruthy()
    // The live run began at 11:55; the readout starts at 5 minutes.
    expect(screen.getByText('0:05:00')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(65_000) })
    expect(screen.getByText('0:06:05')).toBeTruthy()
  })

  it('folds pending local stamps into the live total before the flush lands', () => {
    mount(true, gateSnap(), activitySnap({
      spans: [{ start: at(3, 18, 9), end: at(3, 18, 9, 45) }],
      // A stamp 10 seconds ago bridges to a fresh run, contributing ten live seconds today.
      pendingStamps: [at(3, 18, 11, 59, 50)],
      lastLocalActivity: at(3, 18, 11, 59, 50),
    }))
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('45m')).toBeTruthy()
  })

  it('opens the totals calendar from the info button and closes it', () => {
    mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    expect(screen.getByRole('dialog', { name: 'Coding time stats' })).toBeTruthy()
    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByText('This week')).toBeTruthy()
    expect(screen.getByText('2026-3')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('flips the cover preference from the stats modal toggle', () => {
    const { setGate } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    const toggle = screen.getByRole('button', { name: 'On' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(setGate).toHaveBeenCalledWith(false)
  })

  it('slides the idle delay through the modal input', () => {
    const { setIdleMinutes } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    const input = screen.getAllByDisplayValue('2')[0]!
    fireEvent.change(input, { target: { value: '12.6' } })
    expect(setIdleMinutes).toHaveBeenCalledWith(12.6)
  })

  it('hides the settings rows without a writable Host document', () => {
    mount(true, gateSnap({ writable: false, mode: 'memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    expect(screen.queryByRole('button', { name: 'On' })).toBeNull()
  })
})

describe('CodingTimer rail', () => {
  it('renders the icon button with the state tooltip and opens the modal on click', async () => {
    mount(false, gateSnap(), activitySnap({
      spans: [{ start: at(3, 18, 11, 55), end: at(3, 18, 12, 0) }],
      lastLocalActivity: at(3, 18, 12, 0),
    }))
    const button = screen.getByRole('button', { name: /Active · 0:05:00/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: 'Coding time stats' })).toBeTruthy()
  })

  it('labels the button with today\'s total while idle', () => {
    mount(false, gateSnap(), activitySnap({ spans: [{ start: at(3, 18, 9), end: at(3, 18, 9, 45) }] }))
    expect(screen.getByRole('button', { name: 'Idle · Today 45m' })).toBeTruthy()
  })
})
