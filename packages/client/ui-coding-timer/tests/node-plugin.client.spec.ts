/**
 * Node half: the timer keeps no host state, but its preference pair (focus
 * gate, idle auto-stop) needs the `coding-timer` settings namespace
 * registered when the deployment composes a settings provider — and left
 * alone when it doesn't.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from '../src/index.ts'
import {
  CODING_TIMER_GATE_FIELD, CODING_TIMER_IDLE_FIELD, CODING_TIMER_SETTINGS_NAMESPACE,
  DEFAULT_GATE, DEFAULT_IDLE_MINUTES, clampIdleMinutes, decodeCodingTimerSettings,
} from '../src/settings.ts'

/** In-memory settings provider: the namespace registry without a document. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('ui-coding-timer node plugin', () => {
  it('registers the namespace with its schema defaults and disposes it with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(CODING_TIMER_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual({
      [CODING_TIMER_GATE_FIELD]: DEFAULT_GATE,
      [CODING_TIMER_IDLE_FIELD]: DEFAULT_IDLE_MINUTES,
    })
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('mounts nothing when no settings provider is composed', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(ctx.get('settings')).toBeUndefined()
  })
})

describe('coding-timer settings contract', () => {
  it('decodes a full section verbatim', () => {
    expect(decodeCodingTimerSettings({ [CODING_TIMER_GATE_FIELD]: false, [CODING_TIMER_IDLE_FIELD]: 30 }))
      .toEqual({ [CODING_TIMER_GATE_FIELD]: false, [CODING_TIMER_IDLE_FIELD]: 30 })
  })

  it('defaults each absent field independently, so pre-idle sections still decode', () => {
    expect(decodeCodingTimerSettings({ [CODING_TIMER_GATE_FIELD]: false }))
      .toEqual({ [CODING_TIMER_GATE_FIELD]: false, [CODING_TIMER_IDLE_FIELD]: DEFAULT_IDLE_MINUTES })
    expect(decodeCodingTimerSettings({ [CODING_TIMER_IDLE_FIELD]: 45 }))
      .toEqual({ [CODING_TIMER_GATE_FIELD]: DEFAULT_GATE, [CODING_TIMER_IDLE_FIELD]: 45 })
  })

  it('rejects out-of-schema field values back to their defaults', () => {
    for (const idle of ['10', 1.5, 0, 481, Number.NaN]) {
      expect(decodeCodingTimerSettings({ [CODING_TIMER_GATE_FIELD]: true, [CODING_TIMER_IDLE_FIELD]: idle }))
        .toEqual({ [CODING_TIMER_GATE_FIELD]: true, [CODING_TIMER_IDLE_FIELD]: DEFAULT_IDLE_MINUTES })
    }
    expect(decodeCodingTimerSettings({ [CODING_TIMER_GATE_FIELD]: 'no', [CODING_TIMER_IDLE_FIELD]: 30 }))
      .toEqual({ [CODING_TIMER_GATE_FIELD]: DEFAULT_GATE, [CODING_TIMER_IDLE_FIELD]: 30 })
  })

  it('decodes no opinion (or a non-section) to undefined', () => {
    expect(decodeCodingTimerSettings({})).toBeUndefined()
    expect(decodeCodingTimerSettings({ [CODING_TIMER_GATE_FIELD]: 'no' })).toBeUndefined()
    expect(decodeCodingTimerSettings(null)).toBeUndefined()
    expect(decodeCodingTimerSettings([])).toBeUndefined()
  })

  it('clamps user-entered minutes into the schema bounds', () => {
    expect(clampIdleMinutes(30)).toBe(30)
    expect(clampIdleMinutes(12.6)).toBe(13)
    expect(clampIdleMinutes(0)).toBe(1)
    expect(clampIdleMinutes(9999)).toBe(480)
    expect(clampIdleMinutes(Number.NaN)).toBe(DEFAULT_IDLE_MINUTES)
  })
})
