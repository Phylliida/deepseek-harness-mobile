// @vitest-environment jsdom
/**
 * Coding timer store semantics: idempotent start/stop, the append-only
 * history, clock-skew clamping, and the localStorage persistence channel
 * (jsdom provides the storage the engine rehydrates from).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CODING_TIMER_PERSIST_KEY, createCodingTimerStore } from '../src/client/store.ts'

afterEach(() => {
  localStorage.clear()
})

describe('coding timer store', () => {
  it('starts stopped with an empty history', () => {
    const inst = createCodingTimerStore().create()
    expect(inst.getSnapshot()).toEqual({ activeSince: null, sessions: [] })
  })

  it('times one stretch across start and stop', () => {
    const inst = createCodingTimerStore().create()
    inst.actions.start(1000)
    expect(inst.getSnapshot().activeSince).toBe(1000)
    // Re-starting a running timer is a no-op (double click keeps the start).
    inst.actions.start(2000)
    expect(inst.getSnapshot().activeSince).toBe(1000)
    inst.actions.stop(5000)
    expect(inst.getSnapshot()).toEqual({ activeSince: null, sessions: [{ start: 1000, end: 5000 }] })
    // Stopping a stopped timer is a no-op (no phantom sessions).
    inst.actions.stop(9000)
    expect(inst.getSnapshot().sessions).toHaveLength(1)
  })

  it('clamps a stop earlier than its start to a zero-length session', () => {
    const inst = createCodingTimerStore().create()
    inst.actions.start(5000)
    inst.actions.stop(4000)
    expect(inst.getSnapshot().sessions).toEqual([{ start: 5000, end: 5000 }])
  })

  it('rehydrates the persisted state under the shared key', () => {
    const first = createCodingTimerStore().create()
    first.actions.start(1000)
    first.actions.stop(5000)
    first.actions.start(8000)
    // A second instance under the same persist key sees the stored state —
    // the reload path (HMR, page refresh) rehydrates the running timer too.
    const second = createCodingTimerStore().create()
    expect(second.getSnapshot()).toEqual({ activeSince: 8000, sessions: [{ start: 1000, end: 5000 }] })
    const raw = localStorage.getItem(CODING_TIMER_PERSIST_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual(second.getSnapshot())
  })
})
