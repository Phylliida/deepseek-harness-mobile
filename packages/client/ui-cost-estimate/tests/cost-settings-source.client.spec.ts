import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { CostEstimateSettings } from '../src/cost-settings.ts'
import { bindCostSettingsSource } from '../src/client/cost-settings-source.ts'
import { DEFAULT_COST_RATES, DEFAULT_WEEKLY_BUDGET_USD } from '../src/cost-settings.ts'

const DEFAULTS: CostEstimateSettings = {
  rates: DEFAULT_COST_RATES,
  weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD,
}

describe('bindCostSettingsSource', () => {
  it('publishes the schema defaults while the scope is still loading', () => {
    const stub = stubSettingsScope<CostEstimateSettings>()
    const { store } = bindCostSettingsSource(stub.scope)
    expect(store.getSnapshot()).toEqual(DEFAULTS)
  })

  it('publishes an accepted section when it arrives', () => {
    const stub = stubSettingsScope<CostEstimateSettings>()
    const { store } = bindCostSettingsSource(stub.scope)
    const custom = { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 }
    stub.publish({ status: 'ready', value: { rates: custom, weeklyBudgetUsd: 40 } })
    expect(store.getSnapshot()).toEqual({ rates: custom, weeklyBudgetUsd: 40 })
    // A budget-only revision replaces the published reference too.
    stub.publish({ status: 'ready', value: { rates: custom, weeklyBudgetUsd: 0 } })
    expect(store.getSnapshot()).toEqual({ rates: custom, weeklyBudgetUsd: 0 })
    // A snapshot without a section value falls back to the defaults again.
    stub.publish({ value: undefined })
    expect(store.getSnapshot()).toEqual(DEFAULTS)
  })

  it('keeps the snapshot reference stable across unchanged and unrelated revisions', () => {
    const stub = stubSettingsScope<CostEstimateSettings>()
    const { store } = bindCostSettingsSource(stub.scope)
    const before = store.getSnapshot()
    stub.publish({ revision: 1 })
    stub.publish({ status: 'ready', value: { ...DEFAULTS, rates: { ...DEFAULT_COST_RATES } } })
    expect(store.getSnapshot()).toBe(before)
  })

  it('ignores notifications after disposal', () => {
    const stub = stubSettingsScope<CostEstimateSettings>()
    const { store, dispose } = bindCostSettingsSource(stub.scope)
    expect(stub.listenerCount()).toBe(1)
    dispose()
    expect(stub.listenerCount()).toBe(0)
    stub.publish({ value: { rates: { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 }, weeklyBudgetUsd: 5 } })
    expect(store.getSnapshot()).toEqual(DEFAULTS)
  })
})
