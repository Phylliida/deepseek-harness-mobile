/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-log`.
 * @module @deepseek-ai/dsh-memory-log/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-log'

/** Cordis companion plugin name. */
export const name = 'memory-log-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the store's data relations (LOG.txt and TREE files
 * stay record-aligned; level files hold dense prefixes) are enforced at the
 * owning operations themselves — every mutation repairs a torn tail under
 * the store lock and fsyncs before acknowledging, and a corrupt summary is
 * reported at read with the forget repair path. No independent event stream
 * or cross-package relation exists to check here.
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
