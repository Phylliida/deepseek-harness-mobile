import { describe, expect, it } from 'vitest'
import { fetchKimiUsage, parseKimiUsagePayload, type KimiUsageFetch } from '../src/usage.ts'

/** The live platform payload shape observed 2026-08-24 (numeric fields as strings). */
const LIVE_PAYLOAD = {
  user: { userId: 'u1', region: 'REGION_OVERSEA' },
  usage: { limit: '100', used: '32', remaining: '68', resetTime: '2026-08-30T21:24:44.311859Z' },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: { limit: '100', used: '21', remaining: '79', resetTime: '2026-08-24T22:24:44.311859Z' },
    },
  ],
  parallel: { limit: '30', details: ['id-1'] },
  totalQuota: {},
  authentication: { method: 'METHOD_API_KEY', scope: 'FEATURE_CODING' },
}

describe('parseKimiUsagePayload', () => {
  it('parses the live payload: weekly row plus the 5-hour window', () => {
    expect(parseKimiUsagePayload(LIVE_PAYLOAD)).toEqual({
      windows: [{
        windowMinutes: 300,
        used: 21,
        limit: 100,
        resetAt: '2026-08-24T22:24:44.311859Z',
      }],
      weekly: { used: 32, limit: 100, resetAt: '2026-08-30T21:24:44.311859Z' },
      monthly: null,
    })
  })

  it('reads the monthly row when totalQuota carries one', () => {
    const parsed = parseKimiUsagePayload({
      ...LIVE_PAYLOAD,
      totalQuota: { limit: 300, used: 12, resetAt: '2026-09-01T00:00:00Z' },
    })
    expect(parsed.monthly).toEqual({ used: 12, limit: 300, resetAt: '2026-09-01T00:00:00Z' })
  })

  it('derives used from remaining when the platform omits it', () => {
    const parsed = parseKimiUsagePayload({ usage: { limit: 100, remaining: 40 } })
    expect(parsed.weekly).toEqual({ used: 60, limit: 100 })
  })

  it('defaults used to zero when neither used nor remaining is present', () => {
    const parsed = parseKimiUsagePayload({ usage: { limit: 100 } })
    expect(parsed.weekly).toEqual({ used: 0, limit: 100 })
  })

  it('drops rows without a positive limit and windows without a length', () => {
    const parsed = parseKimiUsagePayload({
      usage: { used: 5 },
      totalQuota: 'unlimited',
      limits: [
        { window: { timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 10, used: 1 } },
        'garbage',
        { window: { duration: 60, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 0, used: 0 } },
        { window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: 50, used: 3 } },
        { window: { duration: 90, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 20, used: 2 } },
      ],
    })
    expect(parsed.weekly).toBeNull()
    expect(parsed.monthly).toBeNull()
    expect(parsed.windows).toEqual([
      { windowMinutes: 90, used: 2, limit: 20 },
      { windowMinutes: 1440, used: 3, limit: 50 },
    ])
  })

  it('sorts windows shortest first and falls back to the item itself for detail', () => {
    const parsed = parseKimiUsagePayload({
      limits: [
        { window: { duration: 1, timeUnit: 'TIME_UNIT_WEEK' }, used: 7, limit: 70 },
        { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, used: 1, limit: 10 },
      ],
    })
    expect(parsed.windows.map(row => row.windowMinutes)).toEqual([300, 10_080])
  })

  it('returns an empty payload for non-object input', () => {
    expect(parseKimiUsagePayload(null)).toEqual({ windows: [], weekly: null, monthly: null })
    expect(parseKimiUsagePayload('nope')).toEqual({ windows: [], weekly: null, monthly: null })
  })

  it('accepts the snake_case time_unit spelling', () => {
    const parsed = parseKimiUsagePayload({
      limits: [{ window: { duration: 5, time_unit: 'TIME_UNIT_HOUR' }, detail: { limit: 10, used: 1 } }],
    })
    expect(parsed.windows).toEqual([{ windowMinutes: 300, used: 1, limit: 10 }])
  })

  it('ignores malformed numbers and unknown time units', () => {
    const parsed = parseKimiUsagePayload({
      usage: { limit: 'lots', used: 3 },
      limits: [
        { window: { duration: 5, timeUnit: 'TIME_UNIT_EPOCH' }, detail: { limit: 10, used: 1 } },
        { window: { duration: Number.NaN, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 10, used: 1 } },
        { window: 'soon', detail: { limit: 10, used: 1 } },
      ],
    })
    expect(parsed).toEqual({ windows: [], weekly: null, monthly: null })
  })
})

describe('fetchKimiUsage', () => {
  function stubFetch(impl: (url: string, init: { headers: Record<string, string> }) => unknown): KimiUsageFetch {
    return (url, init) => Promise.resolve(impl(url, init) as Awaited<ReturnType<KimiUsageFetch>>)
  }

  it('GETs the /v1/usages endpoint with the bearer credential', async () => {
    let seen: { url: string; auth: string | undefined } | undefined
    const payload = await fetchKimiUsage('https://api.kimi.com/coding', 'sk-test', 1_000, stubFetch((url, init) => {
      seen = { url, auth: init.headers['Authorization'] }
      return { ok: true, status: 200, json: () => Promise.resolve(LIVE_PAYLOAD) }
    }))
    expect(seen).toEqual({
      url: 'https://api.kimi.com/coding/v1/usages',
      auth: 'Bearer sk-test',
    })
    expect(payload.weekly?.used).toBe(32)
  })

  it('rejects with the status on a non-2xx answer', async () => {
    await expect(fetchKimiUsage('https://api.kimi.com/coding', 'sk-bad', 1_000, stubFetch(() => ({
      ok: false, status: 401, json: () => Promise.resolve({}),
    })))).rejects.toThrow('HTTP 401')
  })

  it('aborts the request past the timeout', async () => {
    const hanging: KimiUsageFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    await expect(fetchKimiUsage('https://api.kimi.com/coding', 'sk-test', 5, hanging))
      .rejects.toThrow('aborted')
  })
})
