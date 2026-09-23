/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-compaction-autobiographical`.
 * @module @deepseek-ai/dsh-compaction-autobiographical/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction-autobiographical'

/** Cordis companion plugin name. */
export const name = 'compaction-autobiographical-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: fold applications reuse the owning seam's
 * `compaction/*` event contract, whose shape the seam's own invariants cover.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
