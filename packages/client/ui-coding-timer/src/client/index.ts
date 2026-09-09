/**
 * Coding-time tracker plugin, browser half: the CodingTimer row registered
 * into the sidebar-declared `sidebar.timer` seat and the CodingGate idle
 * cover registered into the layout-declared `shell.overlay` seat. Both seats
 * ride `slots.inject()` on their declarations (neither declaring apply has a
 * constrained activation order relative to this one) and both receive the
 * same face: the `coding-timer` Host-settings scope bound as the
 * `hooks.gate` source, the activity controller bound as `hooks.activity`,
 * and the `setGate`/`setIdleMinutes` write callbacks. The controller is the
 * plugin's one wire participant: it stamps window input, flushes batches to
 * `coding.write`, refreshes on the forwarded change event, and runs the
 * legacy localStorage migration — all from `apply`, so no component ever
 * touches the wire.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settingsScope Context merge (the preferences' transport).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the connection handle type the controller's wire face takes.
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  CODING_TIMER_GATE_FIELD, CODING_TIMER_IDLE_FIELD, CODING_TIMER_SETTINGS_NAMESPACE,
  clampIdleMinutes, decodeCodingTimerSettings, type CodingTimerSettings,
} from '../settings.ts'
import type { CodingTimerSettingsFace } from './gate.ts'
import { createCodingActivityController } from './activity.ts'
import { CodingGate } from './CodingGate.tsx'
import { CodingTimer } from './CodingTimer.tsx'
import { en, zh, type CodingTimerKey } from './locales.ts'

export type { CodingTimerSettingsFace } from './gate.ts'
export type { CodingActivitySnapshot } from './activity.ts'
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
 * Required services: the slot registry, the dictionaries, the wire
 * (`connection` for the activity API, `remote` for the forwarded change
 * event), and the settings binder.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Client plugin body: register the `coding-timer` dictionaries, start the
 * activity controller, bind the settings scope, then seat the sidebar row
 * and the idle cover on their declarations with the shared face.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coding-timer: dictionaries')

  const controller = createCodingActivityController(
    (ctx.get('connection') as ConnectionHandle).api,
    listener => ctx.remote.$on('coding-activity/updated', listener),
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-coding-timer: activity controller')

  const scope = ctx.settingsScope.bind<CodingTimerSettings>({
    namespace: CODING_TIMER_SETTINGS_NAMESPACE,
    decode: decodeCodingTimerSettings,
  })
  const settingsFace = (): CodingTimerSettingsFace => ({
    hooks: { gate: scope, activity: controller.source },
    setGate: (on) => { void scope.set(CODING_TIMER_GATE_FIELD, on) },
    setIdleMinutes: (minutes) => { void scope.set(CODING_TIMER_IDLE_FIELD, clampIdleMinutes(minutes)) },
  })

  ctx.slots.inject('sidebar.timer', () => ctx.slots.register(
    { name: 'sidebar.timer', id: 'coding-timer', locale: NS, inject: settingsFace },
    CodingTimer,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'coding-timer-gate', locale: NS, inject: settingsFace },
    CodingGate,
  ))
}
