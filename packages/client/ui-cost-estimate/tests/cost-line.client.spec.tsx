// @vitest-environment jsdom
// CostLine (composer dock lead line): projection gating, rate-driven
// estimate display, budget-share readout, Kimi quota segment, and per-locale copy.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { KimiQuotaSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { CostLine, type CostLineProps } from '../src/client/CostLine.tsx'
import {
  DEFAULT_COST_RATES, DEFAULT_WEEKLY_BUDGET_USD, type CostEstimateSettings,
} from '../src/cost-settings.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

// Mirrors the real lookup chain (cost namespace, then common).
const t = makeTranslate(zh, commonZh) as CostLineProps['t']
const tEn = makeTranslate(en, commonEn) as CostLineProps['t']

const USAGE = {
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 0,
  outputTokens: 100_000,
}

/** Default settings fixture: shipped rates against the shipped weekly budget. */
const DEFAULT_SETTINGS: CostEstimateSettings = {
  rates: DEFAULT_COST_RATES,
  weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD,
}

/** Quota fixture: the current platform payload's three allowance rows. */
const QUOTA: KimiQuotaSnapshot = {
  fetchedAt: '2026-08-24T19:00:00.000Z',
  windows: [{ windowMinutes: 300, used: 21, limit: 100, resetAt: '2026-08-24T22:00:00.000Z' }],
  weekly: { used: 32, limit: 100, resetAt: '2026-08-30T21:00:00.000Z' },
  monthly: { used: 12, limit: 300 },
}

/** Stub the projection seat: a key-addressed table of whole values. */
function projections(values: Record<string, unknown>): CostLineProps['useProjection'] {
  return (key: string) => values[key] as never
}

/** Stub an injected hook seat over one fixed store snapshot. */
function fixedHook<T>(value: T): (selector: (snapshot: T) => unknown) => unknown {
  const store = createSnapshotStore(value)
  return (selector: (snapshot: T) => unknown) => selector(store.getSnapshot())
}

function line(
  values: Record<string, unknown>,
  settings: CostEstimateSettings = DEFAULT_SETTINGS,
  translate: CostLineProps['t'] = t,
  quota: KimiQuotaSnapshot | null = null,
) {
  return render(<CostLine
    useProjection={projections(values)}
    useSettings={fixedHook(settings) as CostLineProps['useSettings']}
    useQuota={fixedHook(quota) as CostLineProps['useQuota']}
    t={translate}
  />)
}

describe('CostLine', () => {
  it('renders nothing until the tokenUsage projection exists', () => {
    expect(line({}).container.textContent).toBe('')
  })

  it('renders nothing while the session has billed no tokens', () => {
    expect(line({
      tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    }).container.textContent).toBe('')
  })

  it('shows the estimate and its weekly-budget share at the configuration defaults', () => {
    // 1M uncached (3.00) + 2M cached-read (0.60) + 100K out (1.50) = $5.10, 4.3% of $120.
    expect(line({ tokenUsage: USAGE }).container.textContent).toBe('预估费用 ~$5.10 (4.3%)')
    expect(line({ tokenUsage: USAGE }, DEFAULT_SETTINGS, tEn).container.textContent).toBe('est. cost ~$5.10 (4.3%)')
  })

  it('reprices and re-shares when the configured rates and budget differ', () => {
    // 10.00 + 2.00 + 0.50 = $12.50, 25% of a $50 budget.
    const custom = {
      rates: { input: 10, cacheRead: 1, cacheWrite: 3, output: 5 },
      weeklyBudgetUsd: 50,
    }
    expect(line({ tokenUsage: USAGE }, custom).container.textContent).toBe('预估费用 ~$12.50 (25%)')
  })

  it('resolves the tooltip budget sentence through the locale namespace', () => {
    // The Tooltip bubble renders only on hover; assert the interpolated copy
    // the line passes it. Mirrors the browser-plugin dictionary assertions.
    expect(t('budget', { budget: '$120', percent: '4.3%' })).toBe('约占每周预算（$120）的 4.3%')
    expect(tEn('budget', { budget: '$120', percent: '4.3%' })).toBe('about 4.3% of the $120 weekly budget')
  })

  it('drops the budget share when the budget is zero', () => {
    const settings = { rates: DEFAULT_COST_RATES, weeklyBudgetUsd: 0 }
    expect(line({ tokenUsage: USAGE }, settings).container.textContent).toBe('预估费用 ~$5.10')
    expect(line({ tokenUsage: USAGE }, settings, tEn).container.textContent).toBe('est. cost ~$5.10')
  })

  it('keeps the quota segment when the budget share is disabled', () => {
    const settings = { rates: DEFAULT_COST_RATES, weeklyBudgetUsd: 0 }
    expect(line({ tokenUsage: USAGE }, settings, tEn, QUOTA).container.textContent)
      .toBe('est. cost ~$5.10 · 5h 21% · wk 32% · mo 12/300')
  })

  it('appends the quota segment after the estimate when the Remote reports one', () => {
    expect(line({ tokenUsage: USAGE }, DEFAULT_SETTINGS, t, QUOTA).container.textContent)
      .toBe('预估费用 ~$5.10 (4.3%) · 5小时 21% · 每周 32% · 每月 12/300')
    expect(line({ tokenUsage: USAGE }, DEFAULT_SETTINGS, tEn, QUOTA).container.textContent)
      .toBe('est. cost ~$5.10 (4.3%) · 5h 21% · wk 32% · mo 12/300')
  })

  it('shows the quota segment alone before the session bills any tokens', () => {
    expect(line({}, DEFAULT_SETTINGS, tEn, QUOTA).container.textContent).toBe('5h 21% · wk 32% · mo 12/300')
    expect(line({
      tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    }, DEFAULT_SETTINGS, t, QUOTA).container.textContent).toBe('5小时 21% · 每周 32% · 每月 12/300')
  })

  it('hides absent allowance rows without disturbing the present ones', () => {
    const windowsOnly: KimiQuotaSnapshot = { ...QUOTA, weekly: null, monthly: null }
    expect(line({ tokenUsage: USAGE }, DEFAULT_SETTINGS, tEn, windowsOnly).container.textContent)
      .toBe('est. cost ~$5.10 (4.3%) · 5h 21%')
  })
})
