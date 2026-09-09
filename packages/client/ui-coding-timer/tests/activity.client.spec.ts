// @vitest-environment jsdom
/**
 * Coding-activity controller spec: the browser half of the shared log.
 * Behavior under test: input events stamp (throttled), batches flush after
 * the trailing delay, write responses adopt newer revisions, the forwarded
 * change event refreshes, the retired localStorage history migrates exactly
 * once, a failed write keeps every stamp pending for a later attempt, and
 * disposal removes every listener and timer. The fake clock starts at the
 * same 2026-03-18 noon as the component specs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { IApiClient, RpcResponse } from '@deepseek-ai/dsh-client-connection/client'
import type { CodingActivityLogView } from '@deepseek-ai/dsh-client-connection/client'
import {
  createCodingActivityController,
  FLUSH_DELAY_MS,
  LEGACY_TIMER_PERSIST_KEY,
  STAMP_THROTTLE_MS,
  type CodingActivityController,
} from '../src/client/activity.ts'

/** Clock-readable seed constructor (2026-03-18, local time). */
function at(hour: number, minute = 0, second = 0): number {
  return new Date(2026, 2, 18, hour, minute, second).getTime()
}

interface FakeCoding {
  api: Pick<IApiClient, 'coding'>
  reads: ReturnType<typeof vi.fn>
  writes: ReturnType<typeof vi.fn>
  view: CodingActivityLogView
  failWrites: boolean
}

/** One in-memory wire double: reads answer the current view, writes fold spans. */
function fakeCoding(): FakeCoding {
  const state: FakeCoding = {
    view: { revision: 0, spans: [] },
    failWrites: false,
    reads: vi.fn(),
    writes: vi.fn(),
    api: undefined as unknown as FakeCoding['api'],
  }
  state.reads.mockImplementation(() => Promise.resolve({
    rpcId: 'r' as never,
    result: { ok: true, value: state.view },
  } satisfies RpcResponse<CodingActivityLogView>))
  state.writes.mockImplementation((batch: { stamps?: number[]; spans?: { start: number; end: number }[] }) => {
    if (state.failWrites) {
      return Promise.resolve({ rpcId: 'w' as never, result: { ok: false, error: { code: 'internal', message: 'down', details: {} } } })
    }
    state.view = {
      revision: state.view.revision + 1,
      spans: [
        ...state.view.spans,
        ...(batch.spans ?? []),
        ...(batch.stamps ?? []).map(stamp => ({ start: stamp, end: stamp })),
      ].sort((a, b) => a.start - b.start),
    }
    return Promise.resolve({ rpcId: 'w' as never, result: { ok: true, value: state.view } })
  })
  state.api = { coding: { read: state.reads, write: state.writes } as unknown as IApiClient['coding'] }
  return state
}

/** Remote-event double carrying the registered listeners. */
function fakeRemote() {
  const listeners = new Set<() => void>()
  return {
    onRemoteChange: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emitRemote: () => { for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

let controller: CodingActivityController | undefined

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(at(12))
})

afterEach(() => {
  controller?.dispose()
  controller = undefined
  vi.useRealTimers()
})

describe('createCodingActivityController', () => {
  it('loads the shared view and reports ready', async () => {
    const wire = fakeCoding()
    wire.view = { revision: 7, spans: [{ start: at(9), end: at(9, 45) }] }
    controller = createCodingActivityController(wire.api, fakeRemote().onRemoteChange)
    await vi.waitFor(() => {
      expect(controller!.source.getSnapshot().status).toBe('ready')
    })
    expect(controller.source.getSnapshot().revision).toBe(7)
    expect(controller.source.getSnapshot().spans).toEqual([{ start: at(9), end: at(9, 45) }])
  })

  it('stamps input at the throttle granularity and flushes the batch', async () => {
    const wire = fakeCoding()
    controller = createCodingActivityController(wire.api, fakeRemote().onRemoteChange)
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().status).toBe('ready') })
    // waitFor's polling may have advanced the fake clock; stamp relative to now.
    const first = Date.now()
    fireEvent.pointerMove(window)
    fireEvent.pointerMove(window)
    // Two events inside the throttle window restamp to one pending stamp.
    expect(controller.source.getSnapshot().pendingStamps).toEqual([first])
    await vi.advanceTimersByTimeAsync(STAMP_THROTTLE_MS)
    const second = Date.now()
    fireEvent.pointerMove(window)
    expect(controller.source.getSnapshot().pendingStamps).toEqual([first, second])
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS)
    expect(wire.writes).toHaveBeenCalledWith({ stamps: [first, second] })
    await vi.waitFor(() => {
      expect(controller!.source.getSnapshot().pendingStamps).toHaveLength(0)
    })
    expect(controller.source.getSnapshot().revision).toBe(1)
    // The flushed batch is gone from the pending buffer, and a failed second
    // attempt does not ride the queue.
    expect(wire.writes).toHaveBeenCalledTimes(1)
  })

  it('refreshes on the forwarded change event', async () => {
    const wire = fakeCoding()
    const remote = fakeRemote()
    controller = createCodingActivityController(wire.api, remote.onRemoteChange)
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().status).toBe('ready') })
    expect(wire.reads).toHaveBeenCalledTimes(1)
    wire.view = { revision: 3, spans: [{ start: at(10), end: at(10, 30) }] }
    remote.emitRemote()
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().revision).toBe(3) })
    expect(wire.reads).toHaveBeenCalledTimes(2)
    expect(remote.listenerCount()).toBe(1)
  })

  it('keeps the batch pending after a failed write and lands it later', async () => {
    const wire = fakeCoding()
    controller = createCodingActivityController(wire.api, fakeRemote().onRemoteChange)
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().status).toBe('ready') })
    wire.failWrites = true
    fireEvent.pointerMove(window)
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS)
    await vi.waitFor(() => { expect(wire.writes).toHaveBeenCalledTimes(1) })
    expect(controller.source.getSnapshot().pendingStamps).toHaveLength(1)
    // The retry cadence eventually lands the same stamp once the wire heals.
    wire.failWrites = false
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.waitFor(() => {
      expect(controller!.source.getSnapshot().pendingStamps).toHaveLength(0)
    })
  })

  it('migrates the legacy localStorage history once, then clears it', async () => {
    const wire = fakeCoding()
    localStorage.setItem(LEGACY_TIMER_PERSIST_KEY, JSON.stringify({
      activeSince: null,
      sessions: [{ start: new Date(2026, 2, 16, 9).getTime(), end: new Date(2026, 2, 16, 10).getTime() }],
    }))
    controller = createCodingActivityController(wire.api, fakeRemote().onRemoteChange)
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().status).toBe('ready') })
    await vi.waitFor(() => { expect(localStorage.getItem(LEGACY_TIMER_PERSIST_KEY)).toBeNull() })
    expect(wire.writes).toHaveBeenCalledWith({
      spans: [{ start: new Date(2026, 2, 16, 9).getTime(), end: new Date(2026, 2, 16, 10).getTime() }],
    })
    expect(controller.source.getSnapshot().spans)
      .toEqual([{ start: new Date(2026, 2, 16, 9).getTime(), end: new Date(2026, 2, 16, 10).getTime() }])
  })

  it('does not migrate a malformed legacy document', async () => {
    const wire = fakeCoding()
    localStorage.setItem(LEGACY_TIMER_PERSIST_KEY, 'not-json')
    controller = createCodingActivityController(wire.api, fakeRemote().onRemoteChange)
    await vi.waitFor(() => { expect(controller!.source.getSnapshot().status).toBe('ready') })
    expect(wire.writes).not.toHaveBeenCalled()
    // The malformed entry is left alone — a hand-edit must not be destroyed.
    expect(localStorage.getItem(LEGACY_TIMER_PERSIST_KEY)).toBe('not-json')
  })

  it('disposes its remote subscription', async () => {
    const wire = fakeCoding()
    const remote = fakeRemote()
    controller = createCodingActivityController(wire.api, remote.onRemoteChange)
    expect(remote.listenerCount()).toBe(1)
    controller.dispose()
    expect(remote.listenerCount()).toBe(0)
    controller = undefined
  })
})
