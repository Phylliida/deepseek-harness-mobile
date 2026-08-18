/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-cost-estimate`.
 * @module @deepseek-ai/dsh-client-ui-cost-estimate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-cost-estimate'

/** Cordis companion plugin name. */
export const name = 'client-ui-cost-estimate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: one Host settings-namespace registration (whose
 * lifecycle the settings service owns) plus one slot entry whose disposal is
 * proven by the browser-plugin spec; the package emits no cordis events and
 * owns no cross-plugin mutable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
