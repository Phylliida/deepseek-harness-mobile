/**
 * The `userModel` session projection: a pure fold over the durable
 * `user-model/armed` / `user-model/disarmed` pair serving clients the whole
 * armed-selection value. Host-computed, seeded by the history tail page,
 * updated by `session/projection` frames — capability absence (user-model not
 * composed) is the key's absence, never a value.
 *
 * @module @deepseek-ai/dsh-user-model/projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { UserModelProjection, UserModelSelection } from './types.ts'

/** Wire validator for the whole projection value. */
const userModelProjectionSchema: ZodType<UserModelProjection> = zod.object({
  provider: zod.string(),
  model: zod.string(),
  prompt: zod.string(),
}).nullable()

/** The user-model projection unit: the armed selection, or null while disarmed. */
export const userModelProjection: ProjectionDefinition<'userModel', UserModelSelection | null> = {
  key: 'userModel',
  schema: userModelProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'user-model/armed') {
      const { provider, model, prompt } = event.data
      return state !== null && state.provider === provider && state.model === model && state.prompt === prompt
        ? state
        : { provider, model, prompt }
    }
    if (event.type === 'user-model/disarmed') return null
    return state
  },
  view: state => state,
  stateVersion: 1,
}
