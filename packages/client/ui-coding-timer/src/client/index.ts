/**
 * Coding-time tracker plugin, browser half: CodingTimer registered into the
 * sidebar-declared `sidebar.timer` seat (between New Session and the
 * workspace browser) with the package's persisted store seated on the entry,
 * plus the `coding-timer` dictionaries. The target slot's declaring apply
 * (ui-sidebar) has no constrained activation order relative to this one, so
 * registration rides `slots.inject()` on the declaration rather than service
 * timing. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createCodingTimerStore } from './store.ts'
import { CodingTimer } from './CodingTimer.tsx'
import { en, zh, type CodingTimerKey } from './locales.ts'

export type { CodingSession, CodingTimerState } from './store.ts'
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
 * Required services: the slot registry and the dictionaries. The store
 * factory itself is not a service edge — it is seated on the registration.
 */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the `coding-timer` dictionaries, then the
 * timer row once the sidebar's `sidebar.timer` declaration is live.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-coding-timer: dictionaries')

  ctx.slots.inject('sidebar.timer', () => ctx.slots.register(
    { name: 'sidebar.timer', id: 'coding-timer', store: createCodingTimerStore(), locale: NS },
    CodingTimer,
  ))
}
