/**
 * Pure log folds over the user-model event pair. The armed selection is a
 * replay quantity — host restarts, cold reads, and every consumer (driver,
 * apiproxy forwarding, projection) read the same fact from the log alone.
 *
 * @module @deepseek-ai/dsh-user-model/state
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { UserModelSelection } from './types.ts'

/**
 * Fold the currently armed user-model selection out of the event log.
 * @param events - the session's durable events.
 * @returns the last armed selection with no later disarm, or null.
 */
export function readUserModelSelection(events: readonly SessionEvent[]): UserModelSelection | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The scan hits one of the two types before any older mate of the pair,
    // so the first match decides; the non-null assertion expresses that the
    // index is in range by construction.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'user-model/disarmed') return null
    if (event.type === 'user-model/armed') {
      return { provider: event.data.provider, model: event.data.model, prompt: event.data.prompt }
    }
  }
  return null
}

/**
 * Count the user-model replies already delivered under the current arming —
 * the driver's per-arming cap quantity. Only `user/message` events carrying a
 * `user-model` source after the last `user-model/armed` count; replies from
 * older arming generations do not consume the fresh cap.
 * @param events - the session's durable events.
 * @returns the number of delivered user-model replies under the current arming.
 */
export function countUserModelReplies(events: readonly SessionEvent[]): number {
  let count = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = events[index]!
    if (event.type === 'user-model/armed' || event.type === 'user-model/disarmed') return count
    if (event.type === 'user/message' && event.data.source.kind === 'user-model') count += 1
  }
  return count
}
