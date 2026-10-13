/**
 * User-model companion domain: durable arm/disarm state, the shared auxiliary
 * LLM call, the role-flipped transcript builder, output parsers, and the
 * `userModel` session projection. The driver and the apiproxy forwarding both
 * consume this package; it holds no scheduling state of its own.
 *
 * @module @deepseek-ai/dsh-user-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { userModelProjection } from './projection.ts'

export * from './types.ts'
export * from './state.ts'
export * from './prompt.ts'
export * from './transcript.ts'
export * from './parse.ts'
export * from './generate.ts'
export { userModelProjection } from './projection.ts'

export const name = 'user-model'

/**
 * Compose the user-model domain: register the `userModel` projection unit
 * when a projection registry is composed (headless assemblies stay
 * unaffected).
 * @param ctx - the composing context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(userModelProjection)
  })
}
