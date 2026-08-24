/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-coding-timer`.
 * @module @deepseek-ai/dsh-client-ui-coding-timer/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-coding-timer'

/** Cordis companion plugin name. */
export const name = 'client-ui-coding-timer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the slot registration is an effect owned and
 * observed by the slot registry, and the timer store's persistence rides the
 * runtime engine's localStorage channel, which its own package covers.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
