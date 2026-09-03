// @vitest-environment jsdom
/**
 * CodingGate props-direct spec: a real persisted-store instance (the
 * test-sanctioned create() path) plus a stubbed settings source drive the
 * cover. Behavior under test: the cover shows only while stopped AND the
 * preference allows it (loading shows nothing — no cover that might lift);
 * the Start Coding button writes the store and thereby lifts the cover;
 * today's total derives from the same overlap primitive; the disable link
 * writes the preference through setGate, rendering only while the Host
 * document accepts writes; and the hosted idle watch stops a forgotten timer
 * at its last activity after the configured idle minutes. The fake clock is
 * 2026-03-18.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CodingGate } from '../src/client/CodingGate.tsx'
import type { CodingGateProps } from '../src/client/CodingGate.tsx'
import { en } from '../src/client/locales.ts'
import type { CodingTimerSettings } from '../src/settings.ts'
import { createCodingTimerStore } from '../src/client/store.ts'

/** Local wall-clock constructor keeping seed data readable. */
function at(month: number, day: number, hour = 0, minute = 0): number {
  return new Date(2026, month - 1, day, hour, minute).getTime()
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
    value: { gate: true, idleMinutes: 10 },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
    ...over,
  }
}

// The gate never reads the global hooks, but they ride the standard props
// share; stub them as never-called functions.
const neverHook = (() => { throw new Error('gate must not read global hooks') }) as never

/** Mount the cover against a fresh store and the given scope snapshot. */
function mount(gate: GateSnapshot) {
  const instance = createCodingTimerStore().create()
  const source = { subscribe: () => () => {}, getSnapshot: () => gate }
  const setGate = vi.fn()
  const setIdleMinutes = vi.fn()
  render(
    <CodingGate
      useSessions={neverHook} useWorkspaces={neverHook}
      useStore={hookOf(instance)} actions={instance.actions}
      useGate={hookOf(source)} setGate={setGate} setIdleMinutes={setIdleMinutes} t={t}
    />,
  )
  return { instance, setGate, setIdleMinutes }
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
  it('covers the UI with the Start Coding button and today\'s total while stopped', () => {
    const { instance } = mount(snap())
    // One 45-minute stretch already on the books today.
    act(() => {
      instance.actions.start(at(3, 18, 9))
      instance.actions.stop(at(3, 18, 9, 45))
    })
    expect(screen.getByText('Coded today')).toBeTruthy()
    expect(screen.getByText('45m')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    // Starting the timer lifts the cover — the app underneath never unmounted.
    expect(instance.getSnapshot().activeSince).toBe(at(3, 18, 12))
    expect(screen.queryByRole('button', { name: 'Start coding' })).toBeNull()
  })

  it('renders nothing while the timer runs', () => {
    const { instance } = mount(snap())
    act(() => { instance.actions.start(at(3, 18, 10)) })
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('renders nothing while the first Host read is in flight', () => {
    mount(snap({ status: 'loading', value: undefined, writable: false }))
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('renders nothing when the preference disables the gate', () => {
    mount(snap({ value: { gate: false, idleMinutes: 10 } }))
    expect(screen.queryByText('Coded today')).toBeNull()
  })

  it('defaults to covering when the namespace is unavailable, without a write affordance', () => {
    mount(snap({ status: 'unavailable', value: undefined, writable: false, mode: 'memory' }))
    expect(screen.getByRole('button', { name: 'Start coding' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep the UI always visible' })).toBeNull()
  })

  it('writes the preference off from the disable link', () => {
    const { setGate } = mount(snap())
    fireEvent.click(screen.getByRole('button', { name: 'Keep the UI always visible' }))
    expect(setGate).toHaveBeenCalledWith(false)
  })
})

describe('CodingGate idle auto-stop', () => {
  it('stops a forgotten timer at its start when no activity ever arrives', () => {
    const { instance } = mount(snap())
    // Start from the cover at the fake noon; the press itself does not fire
    // any watched input event, so the session's own start is the stamp.
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    expect(instance.getSnapshot().activeSince).toBe(at(3, 18, 12))
    act(() => { vi.advanceTimersByTime(10 * 60_000 - 1_000) })
    // One second short of the timeout: still running, no cover.
    expect(instance.getSnapshot().activeSince).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Start coding' })).toBeNull()
    act(() => { vi.advanceTimersByTime(1_000) })
    // The stop records the last activity (the start), so a forgotten timer
    // never bills its idle tail — and the gate cover returns.
    expect(instance.getSnapshot()).toEqual({
      activeSince: null,
      sessions: [{ start: at(3, 18, 12), end: at(3, 18, 12) }],
    })
    expect(screen.getByRole('dialog', { name: 'Start coding' })).toBeTruthy()
  })

  it('re-arms the timeout on input activity and trims the stop to the last one', () => {
    const { instance } = mount(snap())
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    act(() => { vi.advanceTimersByTime(5 * 60_000) })
    fireEvent.pointerMove(window)
    // A second event inside the one-second throttle window restamps nothing.
    act(() => { vi.advanceTimersByTime(500) })
    fireEvent.pointerMove(window)
    act(() => { vi.advanceTimersByTime(9 * 60_000 + 59_000) })
    // 9:59.5 past the last real activity: the re-armed timeout has not fired.
    expect(instance.getSnapshot().activeSince).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1_000) })
    // Fired at 10:00.5 past the last activity; the session ends at that
    // activity (5 minutes in), not at the fire instant.
    expect(instance.getSnapshot().sessions)
      .toEqual([{ start: at(3, 18, 12), end: at(3, 18, 12, 5) }])
    expect(screen.getByRole('dialog', { name: 'Start coding' })).toBeTruthy()
    expect(screen.getByText('5m')).toBeTruthy()
  })

  it('honors the configured timeout instead of the ten-minute default', () => {
    const { instance } = mount(snap({ value: { gate: true, idleMinutes: 1 } }))
    fireEvent.click(screen.getByRole('button', { name: 'Start coding' }))
    act(() => { vi.advanceTimersByTime(61_000) })
    expect(instance.getSnapshot().activeSince).toBeNull()
  })

  it('watches nothing while stopped', () => {
    const { instance } = mount(snap())
    fireEvent.pointerMove(window)
    act(() => { vi.advanceTimersByTime(30 * 60_000) })
    expect(instance.getSnapshot().sessions).toHaveLength(0)
  })
})
