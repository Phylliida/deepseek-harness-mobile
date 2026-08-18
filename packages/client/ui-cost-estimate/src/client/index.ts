/**
 * Session cost estimate, browser half: binds the user-settings rates section
 * into a hook source and registers the estimate line into the composer dock
 * ahead of the stats row.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.settingsScope Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: merges the composer dock key into SlotMap for the register call.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { bindCostSettingsSource } from './cost-settings-source.ts'
import { CostLine, type CostLineInjected } from './CostLine.tsx'
import { en, zh, type CostKey } from './locales.ts'
import { COST_SETTINGS_NAMESPACE, type CostEstimateSettings } from '../cost-settings.ts'

export type { CostLineInjected, CostLineProps } from './CostLine.tsx'
export type { CostKey } from './locales.ts'
export type { CostRates } from '../cost-settings.ts'

/** Locale namespace owning this plugin's copy. */
export const NS = 'cost'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer dock cost line's copy. */
    'cost': CostKey
  }
}

/**
 * Required services: slots and locale for the dock line, plus the settings
 * scope's own preconditions (`connection` transports settings RPCs and
 * `remote` forwards the settings invalidation that the scope subscribes to).
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: register the dictionaries, bind the rates scope into a
 * stable observable, and register the cost line ahead of the stats row
 * (order -1 against the stats row's 0).
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cost-estimate: dictionaries')
  const source = bindCostSettingsSource(
    ctx.settingsScope.bind<CostEstimateSettings>({ namespace: COST_SETTINGS_NAMESPACE }),
  )
  ctx.effect(() => source.dispose, 'ui-cost-estimate: settings source')
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cost',
    order: -1,
    locale: NS,
    inject: (): CostLineInjected => ({ hooks: { settings: source.store } }),
  }, CostLine))
}
