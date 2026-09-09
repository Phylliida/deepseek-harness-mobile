// @vitest-environment jsdom
/**
 * CodingGate props-direct spec: the settings snapshot plus an activity
 * snapshot drive the cover. Behavior under test: the cover shows after the
 * configured idle minutes without local input (never while the preference
 * disables it, the first settings read is in flight, or the activity log
 * has not answered), today's total derives from the same display
 * projection, and the disable link writes the preference through setGate,
 * rendering only while the Host document accepts writes. The fake clock is
 * 2026-03-18.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CodingGate } from '../src/client/CodingGate.tsx'
import type { CodingGateProps } from '../src/client/CodingGate.tsx'
import type { CodingActivitySnapshot } from '../src/client/activity.ts'
import { en } from '../src/client/locales.ts'
import type { CodingTimerSettings } from '../src/settings.ts'

/** Local wall-clock constructor keeping seed data readable. */
function at(month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(2026, month - 1, day, hour, minute, second).getTime()
}

/** English-dictionary translate stub with {name} interpolation. */
const t: CodingGateProps['t'] = (key: string, params?: Record<string, unknown>) => {
  let s = (en as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/** Test-local selector hook over a framework-neutral source. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

type GateSnapshot = SettingsScopeSnapshot<CodingTimerSettings>

/** One scope snapshot; only the fields under test vary. */
function snap(over: Partial<GateSnapshot> = {}): GateSnapshot {
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

/** One activity snapshot; input idled at noon minus the idle delay by default. */
function activity(over: Partial<CodingActivitySnapshot> = {}): CodingActivitySnapshot {
  return {
    status: 'ready',
    revision: 1,
    spans: [],
    pendingStamps: [],
    lastLocalActivity: at(3, 18, 11, 57),
    ...over,
  }
}

// The cover never reads the global hooks, but they ride the standard props
// share; stub them as never-called functions.
const neverHook = (() => { throw new Error('gate must not read global hooks') }) as never

/** Mount the cover against the given scope and activity snapshots. */
function mount(gate: GateSnapshot, activitySnapshot: CodingActivitySnapshot) {
  const settingsSource = { subscribe: () => () => {}, getSnapshot: () => gate }
  const activitySource = { subscribe: () => () => {}, getSnapshot: () => activitySnapshot }
  const setGate = vi.fn()
  const setIdleMinutes = vi.fn()
  render(
    <CodingGate
      useSessions={neverHook} useWorkspaces={neverHook}
      useGate={hookOf(settingsSource)} useActivity={hookOf(activitySource)}
      setGate={setGate} setIdleMinutes={setIdleMinutes} t={t}
    />,
  )
  return { setGate, setIdleMinutes }
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

describe('CodingGate', () => {
  it('covers after the idle delay with today\'s total and the return hint', () => {
    mount(snap(), activity({ spans: [{ start: at(3, 18, 9), end: at(3, 18, 9, 45) }] }))
    expect(screen.getByText('Coded today')).toBeTruthy()
    expect(screen.getByText('45m')).toBeTruthy()
    expect(screen.getByText('Move the mouse or press a key to return')).toBeTruthy()
  })

  it('stays open while input is recent', () => {
    mount(snap(), activity({ lastLocalActivity: at(3, 18, 11, 59) }))
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('honors a longer configured idle delay', () => {
    mount(
      snap({ value: { gate: true, idleMinutes: 10 } }),
      activity({ lastLocalActivity: at(3, 18, 11, 57) }),
    )
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('renders nothing while the first settings read is in flight', () => {
    mount(snap({ status: 'loading', value: undefined, writable: false }), activity())
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('renders nothing while the activity log is still loading or unavailable', () => {
    mount(snap(), activity({ status: 'loading', revision: undefined }))
    expect(screen.queryByText('Coded today')).toBeNull()
    mount(snap(), activity({ status: 'unavailable' }))
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('covers when the idle boundary passes', () => {
    mount(snap(), activity({ lastLocalActivity: at(3, 18, 11, 59) }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByRole('dialog', { name: 'Coded today' })).toBeTruthy()
  })

  it('renders nothing when the preference disables the cover', () => {
    mount(snap({ value: { gate: false, idleMinutes: 2 } }), activity())
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('hides the disable link without a writable Host document', () => {
    mount(snap({ writable: false, mode: 'memory' }), activity())
    expect(screen.getByRole('dialog', { name: 'Coded today' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep the UI always visible' })).toBeNull()
  })

  it('writes the preference off from the disable link', () => {
    const { setGate } = mount(snap(), activity())
    fireEvent.click(screen.getByRole('button', { name: 'Keep the UI always visible' }))
    expect(setGate).toHaveBeenCalledWith(false)
  })
})
