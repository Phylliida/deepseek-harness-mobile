import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import AutobiographicalCompactionEngine from '../src/index.ts'

const Config = AutobiographicalCompactionEngine.Config

describe('autobiographical compaction config', () => {
  it('fills the host-owned knobs and leaves strategy tunables unset', () => {
    // Only the host side is defaulted here; strategy tunables pass through so
    // the library's own defaults rule.
    expect(resolveConfig({})).toEqual({
      storeRoot: '.dsh/autobio',
      reserveTokens: 8192,
      recentWindowTokens: 30_000,
      headWindowTokens: 4000,
      maxMessageTokens: 10_000,
      foldingStrategy: 'kv-stable',
      auto: true,
    })
  })

  it('keeps every caller-supplied knob, including the compile budget override', () => {
    expect(resolveConfig({
      storeRoot: 'custom-store',
      contextWindowTokens: 1000,
      reserveTokens: 1,
      recentWindowTokens: 2,
      headWindowTokens: 3,
      maxMessageTokens: 7,
      targetChunkTokens: 4,
      mergeThreshold: 5,
      maxTokens: 6,
      foldingStrategy: 'flat-profile',
      auto: false,
    })).toEqual({
      storeRoot: 'custom-store',
      contextWindowTokens: 1000,
      reserveTokens: 1,
      recentWindowTokens: 2,
      headWindowTokens: 3,
      maxMessageTokens: 7,
      targetChunkTokens: 4,
      mergeThreshold: 5,
      maxTokens: 6,
      foldingStrategy: 'flat-profile',
      auto: false,
    })
  })

  it('accepts every folding strategy', () => {
    for (const foldingStrategy of ['kv-stable', 'flat-profile', 'oldest-first'] as const) {
      expect(resolveConfig({ foldingStrategy }).foldingStrategy).toBe(foldingStrategy)
    }
  })

  it('validates the schema the loader installs', () => {
    // `static Config` is the loader's gate: an out-of-range knob must fail
    // there rather than reach resolveConfig.
    const accepted = {
      storeRoot: '.dsh/autobio',
      mergeThreshold: 2,
      foldingStrategy: 'oldest-first',
      auto: true,
    } as const
    expect(Config(accepted)).toEqual(accepted)
    expect(() => Config({ mergeThreshold: 1 })).toThrow(/mergeThreshold/)
    expect(() => Config({ recentWindowTokens: 0 })).toThrow(/recentWindowTokens/)
    expect(() => Config({ maxMessageTokens: 0 })).toThrow(/maxMessageTokens/)
    // The strategy union is closed, so an undocumented strategy fails the parse.
    expect(() => Config({ foldingStrategy: 'newest-first' as never })).toThrow(/foldingStrategy/)
  })
})
