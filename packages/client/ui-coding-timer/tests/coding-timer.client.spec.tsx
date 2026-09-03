// @vitest-environment jsdom
/**
 * CodingTimer props-direct spec: a real persisted-store instance (the
 * test-sanctioned create() path) drives the row, and the translate seat is a
 * stub over the shipped en dictionary. Behavior under test: the start/stop
 * toggle writes the store, the elapsed readout ticks while running, the info
 * button opens the totals calendar (today/this-week summary, day cells, week
 * column, month navigation), and the rail renders the icon-only toggle. The
 * fake clock is 2026-03-18 (a Wednesday) so calendar expectations are exact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CodingTimer } from '../src/client/CodingTimer.tsx'
import type { CodingTimerProps } from '../src/client/CodingTimer.tsx'
import { en } from '../src/client/locales.ts'
import type { CodingTimerSettings } from '../src/settings.ts'
import { createCodingTimerStore } from '../src/client/store.ts'

/** Local wall-clock constructor keeping seed data readable. */
function at(month: number, day: number, hour = 0, minute = 0): number {
  return new Date(2026, month - 1, day, hour, minute).getTime()
}

/** English-dictionary translate stub with {name} interpolation. */
const t: CodingTimerProps['t'] = (key: string, params?: Record<string, unknown>) => {
  let s = (en as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** Test-local selector hook over a framework-neutral store instance. */
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
    value: { gate: true, idleMinutes: 10 },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
    ...over,
  }
}

/** Mount the row against a fresh store (persist key rehydrates: clear first). */
function mount(wide: boolean, gate = gateSnap()) {
  const instance = createCodingTimerStore().create()
  const source = { subscribe: () => () => {}, getSnapshot: () => gate }
  const setGate = vi.fn()
  const setIdleMinutes = vi.fn()
  const utils = render(
    <CodingTimer
      wide={wide}
      useSessions={neverHook} useWorkspaces={neverHook}
      useStore={hookOf(instance)} actions={instance.actions}
      useGate={hookOf(source)} setGate={setGate} setIdleMinutes={setIdleMinutes} t={t}
    />,
  )
  return { instance, setGate, setIdleMinutes, ...utils }
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
  it('toggles between Start and Stop Coding and records the stretch', () => {
    const { instance } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    expect(instance.getSnapshot().activeSince).toBe(at(3, 18, 12))
    // The running bar shows Stop coding and the ticking readout (the readout
    // joins the button's accessible name).
    const stop = screen.getByRole('button', { name: /Stop coding/ })
    expect(stop.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('0:00:00')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(65_000) })
    expect(screen.getByText('0:01:05')).toBeTruthy()
    fireEvent.click(stop)
    expect(instance.getSnapshot()).toEqual({
      activeSince: null,
      sessions: [{ start: at(3, 18, 12), end: at(3, 18, 12) + 65_000 }],
    })
    expect(screen.getByRole('button', { name: 'Start coding' })).toBeTruthy()
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

  it('flips the gate preference from the stats modal toggle', () => {
    const { setGate } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    const toggle = screen.getByRole('button', { name: 'On' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(setGate).toHaveBeenCalledWith(false)
  })

  it('hides the settings rows when the Host document accepts no writes', () => {
    mount(true, gateSnap({ writable: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    expect(screen.queryByRole('button', { name: 'On' })).toBeNull()
    expect(screen.queryByText('Show the start screen while stopped')).toBeNull()
    expect(screen.queryByRole('spinbutton', { name: 'Auto-stop when idle for' })).toBeNull()
  })

  it('writes the idle timeout from the stats modal, ignoring non-numbers', () => {
    const { setIdleMinutes } = mount(true)
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    const input = screen.getByRole('spinbutton', { name: 'Auto-stop when idle for' })
    expect((input as HTMLInputElement).value).toBe('10')
    // A cleared field parses to NaN and writes nothing (the controlled value
    // stays); a whole number rides the face's write callback.
    fireEvent.change(input, { target: { value: '' } })
    expect(setIdleMinutes).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '25' } })
    expect(setIdleMinutes).toHaveBeenCalledWith(25)
  })

  it('re-enables the gate from the modal when the preference is off', () => {
    const { setGate } = mount(true, gateSnap({ value: { gate: false, idleMinutes: 10 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    const toggle = screen.getByRole('button', { name: 'Off' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(setGate).toHaveBeenCalledWith(true)
  })

  it('shows daily and weekly totals, including the live stretch', () => {
    const { instance } = mount(true)
    // Completed: 1h today (09:00–10:00), 45m on Monday (same ISO week).
    act(() => {
      instance.actions.start(at(3, 18, 9))
      instance.actions.stop(at(3, 18, 10))
      instance.actions.start(at(3, 16, 10))
      instance.actions.stop(at(3, 16, 10, 45))
      // Running: 90 minutes up to the fake clock (10:30–12:00).
      instance.actions.start(at(3, 18, 10, 30))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    // Today: 1h completed + 90m live = 2.5h; week adds Monday's 45m. The
    // week total appears in both the summary strip and the current week row.
    expect(screen.getAllByText('2h 30m').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3h 15m').length).toBeGreaterThan(0)
    // Monday's cell shows its own total.
    expect(screen.getByText('45m')).toBeTruthy()
  })

  it('navigates months without losing totals', () => {    const { instance } = mount(true)
    act(() => {
      instance.actions.start(at(2, 10, 9)) // February: 1h
      instance.actions.stop(at(2, 10, 10))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Coding time stats' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByText('2026-2')).toBeTruthy()
    expect(screen.getAllByText('1h 0m').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('2026-3')).toBeTruthy()
  })
})

describe('CodingTimer rail', () => {
  it('renders the icon-only toggle and times the stretch', () => {
    const { instance } = mount(false)
    // No info affordance in the rail; the calendar rides the wide row.
    expect(screen.queryByRole('button', { name: 'Coding time stats' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    act(() => { vi.advanceTimersByTime(5000) })
    const stop = screen.getByRole('button', { name: 'Stop coding · 0:00:05' })
    expect(stop.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(stop)
    expect(instance.getSnapshot().sessions).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Start coding' })).toBeTruthy()
  })
})
