import { describe, expect, it } from 'vitest'
import {
  CostEstimateSettingsSchema, DEFAULT_COST_RATES, DEFAULT_WEEKLY_BUDGET_USD,
} from '../src/cost-settings.ts'

describe('CostEstimateSettingsSchema', () => {
  it('fills the whole section from defaults', () => {
    // Wire input is partial JSON, not the typed section, hence `as never`.
    expect(CostEstimateSettingsSchema({} as never)).toEqual({
      rates: DEFAULT_COST_RATES,
      weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD,
    })
  })

  it('fills individual fields the user omits', () => {
    expect(CostEstimateSettingsSchema({ rates: { input: 1 } } as never)).toEqual({
      rates: { ...DEFAULT_COST_RATES, input: 1 },
      weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD,
    })
    expect(CostEstimateSettingsSchema({ weeklyBudgetUsd: 40 } as never)).toEqual({
      rates: DEFAULT_COST_RATES,
      weeklyBudgetUsd: 40,
    })
  })

  it('accepts a zero budget (the share readout is hidden)', () => {
    expect(CostEstimateSettingsSchema({ weeklyBudgetUsd: 0 } as never).weeklyBudgetUsd).toBe(0)
  })

  it('rejects negative and non-number fields', () => {
    expect(() => CostEstimateSettingsSchema({ rates: { input: -1 } } as never)).toThrow()
    expect(() => CostEstimateSettingsSchema({ rates: { output: 'cheap' } } as never)).toThrow()
    expect(() => CostEstimateSettingsSchema({ weeklyBudgetUsd: -120 } as never)).toThrow()
    expect(() => CostEstimateSettingsSchema({ weeklyBudgetUsd: 'weekly' } as never)).toThrow()
  })
})
