/** Settings-observable binding: a stable-referenced store derived from the settings scope. */

import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_COST_RATES, DEFAULT_WEEKLY_BUDGET_USD, type CostEstimateSettings,
} from '../cost-settings.ts'

/** Fieldwise comparison: an unrelated settings revision never replaces the published reference. */
function sameSettings(a: CostEstimateSettings, b: CostEstimateSettings): boolean {
  return a.weeklyBudgetUsd === b.weeklyBudgetUsd
    && a.rates.input === b.rates.input
    && a.rates.cacheRead === b.rates.cacheRead
    && a.rates.cacheWrite === b.rates.cacheWrite
    && a.rates.output === b.rates.output
}

/** Section value or the shipped defaults while the scope is loading or unavailable. */
function resolveSettings(snapshot: SettingsScopeSnapshot<CostEstimateSettings>): CostEstimateSettings {
  return snapshot.value ?? { rates: DEFAULT_COST_RATES, weeklyBudgetUsd: DEFAULT_WEEKLY_BUDGET_USD }
}

/**
 * Bind the scope's cost-estimate section into a standalone observable store.
 * The store publishes one immutable reference per actual section change; the
 * returned disposer removes the scope subscription.
 * @param scope - the bound `ui-cost-estimate` settings scope.
 * @returns the settings store plus the subscription disposer.
 */
export function bindCostSettingsSource(
  scope: SettingsScope<CostEstimateSettings>,
): { store: SnapshotStore<CostEstimateSettings>; dispose: () => void } {
  const store = createSnapshotStore<CostEstimateSettings>(resolveSettings(scope.getSnapshot()))
  const dispose = scope.subscribe(() => {
    const next = resolveSettings(scope.getSnapshot())
    if (!sameSettings(store.getSnapshot(), next)) store.set(next)
  })
  return { store, dispose }
}
