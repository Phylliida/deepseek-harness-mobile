import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KimiQuotaSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { bindKimiQuotaSource, KIMI_QUOTA_REFRESH_MS } from '../src/client/quota-source.ts'

const SNAPSHOT: KimiQuotaSnapshot = {
  fetchedAt: '2026-08-24T19:00:00.000Z',
  windows: [{ windowMinutes: 300, used: 21, limit: 100 }],
  weekly: { used: 32, limit: 100 },
  monthly: null,
}

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the microtask a resolved fetch publishes through. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('bindKimiQuotaSource', () => {
  it('refreshes immediately and republishes one reference per actual change', async () => {
    vi.useFakeTimers()
    let next: KimiQuotaSnapshot | null = SNAPSHOT
    const source = bindKimiQuotaSource(() => Promise.resolve(next))
    await settled()
    expect(source.store.getSnapshot()).toEqual(SNAPSHOT)
    const first = source.store.getSnapshot()

    // A fresh but identical payload keeps the published reference.
    vi.advanceTimersByTime(KIMI_QUOTA_REFRESH_MS)
    await settled()
    expect(source.store.getSnapshot()).toBe(first)

    next = { ...SNAPSHOT, windows: [{ windowMinutes: 300, used: 22, limit: 100 }] }
    vi.advanceTimersByTime(KIMI_QUOTA_REFRESH_MS)
    await settled()
    expect(source.store.getSnapshot()?.windows[0]?.used).toBe(22)
    source.dispose()
  })

  it('keeps the previous snapshot when a poll rejects', async () => {
    vi.useFakeTimers()
    let fail = false
    const source = bindKimiQuotaSource(() => fail
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(SNAPSHOT))
    await settled()
    expect(source.store.getSnapshot()).toEqual(SNAPSHOT)

    fail = true
    vi.advanceTimersByTime(KIMI_QUOTA_REFRESH_MS)
    await settled()
    expect(source.store.getSnapshot()).toEqual(SNAPSHOT)
    source.dispose()
  })

  it('stops polling after dispose', async () => {
    vi.useFakeTimers()
    let calls = 0
    const source = bindKimiQuotaSource(() => {
      calls += 1
      return Promise.resolve(null)
    })
    await settled()
    source.dispose()
    vi.advanceTimersByTime(KIMI_QUOTA_REFRESH_MS * 3)
    await settled()
    expect(calls).toBe(1)
  })
})
