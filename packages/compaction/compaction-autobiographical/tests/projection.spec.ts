/**
 * The `compactionConfig` projection: the newest `compaction/config` event wins,
 * field by field, and everything before the first event is the backend default —
 * folding on, no window override.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { compactionConfigProjectionDefinition as projection } from '../src/projection.ts'

/** One `compaction/config` event in the shape the fold reads. */
function config(data: { enabled?: boolean; operatingWindowTokens?: number | null }): SessionEvent {
  return { seq: 1, time: 1_700_000_000_000, type: 'compaction/config', data }
}

describe('the compactionConfig projection', () => {
  it('starts with folding on and no window override', () => {
    expect(projection.init()).toEqual({ enabled: true, operatingWindowTokens: null })
  })

  it('keeps its state for an event that is not a settings write', () => {
    const state = projection.init()
    const other = { seq: 1, time: 1, type: 'turn/start', data: { turn: 0 } } as SessionEvent
    expect(projection.apply(state, other)).toBe(state)
  })

  it('moves only the knob an event sets', () => {
    const paused = projection.apply(projection.init(), config({ enabled: false }))
    expect(paused).toEqual({ enabled: false, operatingWindowTokens: null })
    const windowed = projection.apply(paused, config({ operatingWindowTokens: 64_000 }))
    expect(windowed).toEqual({ enabled: false, operatingWindowTokens: 64_000 })
  })

  it('clears the window override when an event clears it', () => {
    const windowed = projection.apply(projection.init(), config({ operatingWindowTokens: 64_000 }))
    expect(projection.apply(windowed, config({ operatingWindowTokens: null }))).toEqual({
      enabled: true,
      operatingWindowTokens: null,
    })
  })

  it('keeps both knobs for an event that sets neither', () => {
    const set = projection.apply(projection.init(), config({ enabled: false, operatingWindowTokens: 64_000 }))
    expect(projection.apply(set, config({}))).toEqual(set)
  })

  it('views its state as itself, in the shape the wire validates', () => {
    const state = projection.apply(projection.init(), config({ enabled: false, operatingWindowTokens: 64_000 }))
    expect(projection.schema.parse(projection.view(state))).toEqual(state)
  })
})
