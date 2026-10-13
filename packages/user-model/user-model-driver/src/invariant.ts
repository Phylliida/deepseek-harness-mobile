/** Package-owned invariant companion for `@deepseek-ai/dsh-user-model-driver`. @module @deepseek-ai/dsh-user-model-driver/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-model-driver'
/** Cordis companion plugin name. */
export const name = 'user-model-driver-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']
/**
 * No runtime invariant: all driver state is derived from the durable session
 * log, whose provenance invariants live in `@deepseek-ai/dsh-user-model`.
 */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
