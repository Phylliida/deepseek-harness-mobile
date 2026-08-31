import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { KimiQuotaSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  formatQuotaSegments, formatQuotaTooltip, formatQuotaUsage, formatWindowLabel, type CostTranslate,
} from '../src/client/quota-format.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh) as CostTranslate
const tEn = makeTranslate(en, commonEn) as CostTranslate

const NOW = Date.parse('2026-08-24T19:00:00.000Z')

const SNAPSHOT: KimiQuotaSnapshot = {
  fetchedAt: '2026-08-24T19:00:00.000Z',
  windows: [{ windowMinutes: 300, used: 21, limit: 100, resetAt: '2026-08-24T21:30:00.000Z' }],
  weekly: { used: 32, limit: 100, resetAt: '2026-08-30T21:00:00.000Z' },
  monthly: { used: 40, limit: 300 },
}

describe('formatQuotaUsage', () => {
  it('reads percent-scaled rows as percents and absolute caps as fractions', () => {
    expect(formatQuotaUsage({ used: 21, limit: 100 })).toBe('21%')
    expect(formatQuotaUsage({ used: 40, limit: 300 })).toBe('40/300')
  })
})

describe('formatWindowLabel', () => {
  it('reads whole hours as hours and anything else as minutes', () => {
    expect(formatWindowLabel(300, tEn)).toBe('5h')
    expect(formatWindowLabel(300, t)).toBe('5小时')
    expect(formatWindowLabel(90, tEn)).toBe('90m')
    expect(formatWindowLabel(90, t)).toBe('90分钟')
  })
})

describe('formatQuotaSegments', () => {
  it('joins windows, weekly, and monthly rows', () => {
    expect(formatQuotaSegments(SNAPSHOT, tEn)).toBe('5h 21% · wk 32% · mo 40/300')
    expect(formatQuotaSegments(SNAPSHOT, t)).toBe('5小时 21% · 每周 32% · 每月 40/300')
  })

  it('skips absent rows and empties out on a bare snapshot', () => {
    expect(formatQuotaSegments({ ...SNAPSHOT, monthly: null }, tEn)).toBe('5h 21% · wk 32%')
    expect(formatQuotaSegments({ fetchedAt: SNAPSHOT.fetchedAt, windows: [], weekly: null, monthly: null }, tEn)).toBe('')
  })
})

describe('formatQuotaTooltip', () => {
  it('details every row with its reset hint', () => {
    expect(formatQuotaTooltip(SNAPSHOT, tEn, NOW))
      .toBe('Kimi Code quota: 5h 21% (resets in 2h 30m) · wk 32% (resets in 6d 2h) · mo 40/300')
    expect(formatQuotaTooltip(SNAPSHOT, t, NOW))
      .toBe('Kimi Code 配额: 5小时 21% (2h 30m后重置) · 每周 32% (6d 2h后重置) · 每月 40/300')
  })

  it('marks a past reset instant as reset and skips unparseable ones', () => {
    const snapshot: KimiQuotaSnapshot = {
      ...SNAPSHOT,
      windows: [{ windowMinutes: 300, used: 21, limit: 100, resetAt: '2026-08-24T18:00:00.000Z' }],
      weekly: { used: 32, limit: 100, resetAt: 'not a date' },
      monthly: null,
    }
    expect(formatQuotaTooltip(snapshot, tEn, NOW)).toBe('Kimi Code quota: 5h 21% (reset) · wk 32%')
  })

  it('empties out when no row was reported', () => {
    expect(formatQuotaTooltip({ fetchedAt: SNAPSHOT.fetchedAt, windows: [], weekly: null, monthly: null }, tEn, NOW)).toBe('')
  })
})
