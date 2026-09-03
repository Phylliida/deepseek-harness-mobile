/**
 * Coding-time tracker plugin, browser half: the CodingTimer row registered
 * into the sidebar-declared `sidebar.timer` seat and the CodingGate cover
 * registered into the layout-declared `shell.overlay` seat. Both seats ride
 * `slots.inject()` on their declarations (neither declaring apply has a
 * constrained activation order relative to this one), both share ONE
 * persisted store handle (the sanctioned multi-register share), and both
 * receive the same settings face: the `coding-timer` Host-settings scope
 * bound as the `hooks.gate` source plus the `setGate`/`setIdleMinutes` write
 * callbacks, so the sidebar modal's controls and the gate cover's disable
 * link write the same fields.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settingsScope Context merge (the preferences' transport).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CODING_TIMER_GATE_FIELD, CODING_TIMER_IDLE_FIELD, CODING_TIMER_SETTINGS_NAMESPACE,
  clampIdleMinutes, decodeCodingTimerSettings, type CodingTimerSettings,
} from '../settings.ts'
import type { CodingTimerSettingsFace } from './gate.ts'
import { createCodingTimerStore } from './store.ts'
import { CodingGate } from './CodingGate.tsx'
import { CodingTimer } from './CodingTimer.tsx'
import { en, zh, type CodingTimerKey } from './locales.ts'

export type { CodingSession, CodingTimerState } from './store.ts'
export type { CodingTimerSettingsFace } from './gate.ts'
export type { CodingGateProps } from './CodingGate.tsx'
export type { CodingTimerProps } from './CodingTimer.tsx'
export type { CodingTimerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Coding timer row + totals calendar copy. */
    'coding-timer': CodingTimerKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'coding-timer'

/**
 * Required services: the slot registry, the dictionaries, and the settings
 * transport chain the scope binding reads (`connection` for the wire,
 * `remote` for the forwarded invalidation, `settingsScope` for the binder).
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: register the `coding-timer` dictionaries, bind the
 * settings scope, then seat the sidebar row and the gate cover on their
 * declarations with the shared store and settings face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coding-timer: dictionaries')

  const scope = ctx.settingsScope.bind<CodingTimerSettings>({
    namespace: CODING_TIMER_SETTINGS_NAMESPACE,
    decode: decodeCodingTimerSettings,
  })
  const settingsFace = (): CodingTimerSettingsFace => ({
    hooks: { gate: scope },
    setGate: (on) => { void scope.set(CODING_TIMER_GATE_FIELD, on) },
    setIdleMinutes: (minutes) => { void scope.set(CODING_TIMER_IDLE_FIELD, clampIdleMinutes(minutes)) },
  })

  const store = createCodingTimerStore()
  ctx.slots.inject('sidebar.timer', () => ctx.slots.register(
    { name: 'sidebar.timer', id: 'coding-timer', store, locale: NS, inject: settingsFace },
    CodingTimer,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'coding-timer-gate', store, locale: NS, inject: settingsFace },
    CodingGate,
  ))
}
