import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply, COST_SETTINGS_NAMESPACE, DEFAULT_COST_RATES, DEFAULT_WEEKLY_BUDGET_USD } from '../src/index.ts'

/** In-memory provider: the smallest real Settings Provider, per the settings suite's own fixture pattern. */
class MemorySettings extends SettingsProvider {
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(): Promise<void> { return Promise.resolve() }
}

describe('host apply', () => {
  it('registers the namespace so the provider resolves the schema defaults', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    expect(ctx.settings.get(settingsNamespace(COST_SETTINGS_NAMESPACE))).toEqual({
      rates: DEFAULT_COST_RATES,
      weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD,
    })
  })

  it('waits when no settings provider is composed', () => {
    expect(() => { apply(new Context()) }).not.toThrow()
  })
})
