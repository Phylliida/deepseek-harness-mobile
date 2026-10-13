/**
 * Package-owned user-model provenance invariants: a delivered user-model
 * reply must be reconstructible from the durable prefix — an armed selection
 * with no later disarm, whose route the message's source echoes.
 *
 * @module @deepseek-ai/dsh-user-model/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { readUserModelSelection } from './state.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-model'

/** Cordis companion plugin name. */
export const name = 'user-model-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one package-owned user message against its durable prefix. */
function validateEvent(
  prior: readonly SessionEvent[],
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (event.type !== 'user/message') return
  const source = event.data.source
  if (source.kind !== 'user-model') return
  const selection = readUserModelSelection(prior)
  if (selection === null) {
    fail('user-model message has no armed selection in the preceding durable log')
  }
  if (selection.provider !== source.provider || selection.model !== source.model) {
    fail(`user-model message route ${source.provider}/${source.model} does not match the armed route ${selection.provider}/${selection.model}`)
  }
}

/** Check existing sessions and every candidate event before Session publishes it. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    const prior: SessionEvent[] = []
    for (const event of session.events) {
      validateEvent(prior, event, fail)
      prior.push(event)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the user-model invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
