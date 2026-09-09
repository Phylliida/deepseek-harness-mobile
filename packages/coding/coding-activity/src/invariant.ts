/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-coding-activity`.
 * @module @deepseek-ai/dsh-coding-activity/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-coding-activity'

/** Cordis companion plugin name. */
export const name = 'coding-activity-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the change-event contract: `coding-activity/updated` revisions
 * strictly increase, and each emission matches the service's authoritative
 * current revision.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  let last = 0
  ctx.on('coding-activity/updated', (revision) => {
    const service = ctx.get('codingActivity')
    if (service === undefined) {
      fail('coding-activity/updated emitted without a live coding-activity log')
      return
    }
    if (revision <= last) {
      fail(`coding-activity/updated revision ${String(revision)} did not increase over ${String(last)}`)
    }
    last = revision
    void service.read().then((current) => {
      if (current.revision < revision) {
        fail(`coding-activity/updated revision ${String(revision)} overtakes the authoritative log`)
      }
    })
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
