import { describe, expect, it } from 'vitest'
import { estimateCost, formatBudgetPercent, formatCost, formatTokens } from '../src/cost.ts'
import { DEFAULT_COST_RATES } from '../src/cost-settings.ts'

describe('estimateCost', () => {
  it('is zero when no tokens were billed', () => {
    expect(estimateCost({
      uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    }, DEFAULT_COST_RATES)).toBe(0)
  })

  it('prices each bucket at its own rate per million tokens', () => {
    const cost = estimateCost({
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 500_000,
      outputTokens: 100_000,
    }, DEFAULT_COST_RATES)
    // 3.00 + 0.60 + 1.50 + 1.50 = 6.60
    expect(cost).toBeCloseTo(6.6, 10)
  })

  it('honors user-supplied rates', () => {
    const cost = estimateCost({
      uncachedInputTokens: 1_000_000,
      cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    }, { input: 50, cacheRead: 0, cacheWrite: 0, output: 0 })
    expect(cost).toBe(50)
  })
})

describe('formatCost', () => {
  it('renders nothing when unprompted', () => {
    expect(formatCost(0)).toBe('~$0')
  })
  it('keeps four decimals under a cent', () => {
    expect(formatCost(0.00125)).toBe('~$0.0013')
  })
  it('keeps three decimals under a dollar', () => {
    expect(formatCost(0.1249)).toBe('~$0.125')
  })
  it('keeps two decimals from a dollar up', () => {
    expect(formatCost(6.6)).toBe('~$6.60')
    expect(formatCost(1234.567)).toBe('~$1234.57')
  })
})

describe('formatBudgetPercent', () => {
  it('is an exact zero percent for zero spend', () => {
    expect(formatBudgetPercent(0, 120)).toBe('0%')
  })
  it('floors a nonzero sub-permille share to <0.1%', () => {
    expect(formatBudgetPercent(0.01, 120)).toBe('<0.1%')
  })
  it('keeps tenths under a hundred percent', () => {
    expect(formatBudgetPercent(6.6, 120)).toBe('5.5%')
    expect(formatBudgetPercent(119, 120)).toBe('99.2%')
  })
  it('rounds to whole percents on overspend', () => {
    expect(formatBudgetPercent(120, 120)).toBe('100%')
    expect(formatBudgetPercent(245, 120)).toBe('204%')
  })
})

describe('formatTokens', () => {
  it('keeps counts below a thousand literal', () => {
    expect(formatTokens(517)).toBe('517')
  })
  it('compacts thousands and millions', () => {
    expect(formatTokens(12_250)).toBe('12.3K')
    expect(formatTokens(517_000)).toBe('517K')
    expect(formatTokens(1_230_000)).toBe('1.2M')
  })
})
