/**
 * Coding-time tracker plugin, node half.
 *
 * The timer itself is a personal wellbeing surface: its history is the
 * cross-device interaction log the `coding-activity` provider keeps
 * (`coding.read`/`coding.write` over the gateway), never the session log,
 * and no model-facing tool reads it. The one settings concern is the
 * preference pair (idle cover on/off, idle minutes): registering the
 * `coding-timer` settings namespace so the browser scope can durably store
 * whether idle time covers the UI and after how long (src/settings.ts owns
 * the shared section contract).
 */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CODING_TIMER_SETTINGS_NAMESPACE, CodingTimerSettingsSchema } from './settings.ts'

const NAMESPACE = settingsNamespace(CODING_TIMER_SETTINGS_NAMESPACE)

/**
 * Register the coding-timer settings namespace when the deployment composes
 * a settings provider; without one there is no preference to keep and the
 * browser gate falls back to its shipped default.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, CodingTimerSettingsSchema)
  })
}
