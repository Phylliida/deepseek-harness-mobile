/** Host registration for the session cost-estimate settings section (rates + weekly budget). */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { COST_SETTINGS_NAMESPACE, CostEstimateSettingsSchema } from './cost-settings.ts'

export {
  COST_SETTINGS_NAMESPACE,
  CostEstimateSettingsSchema,
  DEFAULT_COST_RATES,
  DEFAULT_WEEKLY_BUDGET_USD,
  RATES_FIELD,
  WEEKLY_BUDGET_FIELD,
} from './cost-settings.ts'
export type { CostEstimateSettings, CostRates } from './cost-settings.ts'

/**
 * Register the durable settings section when a settings provider is composed.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(settingsNamespace(COST_SETTINGS_NAMESPACE), CostEstimateSettingsSchema)
  })
}
