/**
 * The `compactionConfig` projection: the session's memory settings as its newest
 * `compaction/config` event left them — folding enabled and the window override
 * unset before the first event lands. The fold is latest-wins per field, so one
 * event may move either knob alone, and a `null` window clears the override back
 * to the backend's configured default.
 *
 * @module
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { CompactionConfigProjection } from '@deepseek-ai/dsh-compaction/types'

const configSchema = z.object({
  enabled: z.boolean(),
  operatingWindowTokens: z.number().int().positive().nullable(),
}).strict() as z.ZodType<CompactionConfigProjection>

/** Latest-wins fold over `compaction/config` events; any other event keeps the state reference. */
export const compactionConfigProjectionDefinition:
ProjectionDefinition<'compactionConfig', CompactionConfigProjection> = {
  key: 'compactionConfig',
  schema: configSchema,
  init: () => ({ enabled: true, operatingWindowTokens: null }),
  apply: (state, event) => {
    if (event.type !== 'compaction/config') return state
    return {
      enabled: event.data.enabled ?? state.enabled,
      operatingWindowTokens: 'operatingWindowTokens' in event.data
        ? event.data.operatingWindowTokens ?? null
        : state.operatingWindowTokens,
    }
  },
  view: state => state,
  stateVersion: 1,
}
