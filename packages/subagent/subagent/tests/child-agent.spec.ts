/**
 * Child route tiers (`resolveChildRoute`): an explicit per-request override,
 * else the session's installed `ctx.subagentModel` default, else the parent's
 * own route — and `resolveChildAgentOptions` carrying maxTokens and depth
 * independently of that tiering.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  resolveChildAgentOptions, resolveChildRoute, type SubagentModelOverride,
} from '../src/child-agent.ts'

/** Minimal parent: AgentOptions plus a root scope holding the optional override. */
function parentOf(options: AgentOptions, override?: SubagentModelOverride): Agent {
  const ctx = new Context()
  if (override !== undefined) ctx.provide('subagentModel', override)
  return { options, ctx } as unknown as Agent
}

describe('resolveChildRoute()', () => {
  it('inherits the parent route when no tier overrides it', () => {
    const parent = parentOf({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(resolveChildRoute(parent, undefined))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('reports absent fields when no tier supplies them', () => {
    expect(resolveChildRoute(parentOf({}), undefined)).toEqual({})
  })

  it('prefers the session subagent default over the parent route', () => {
    const parent = parentOf(
      { provider: 'deepseek-official', model: 'deepseek-chat' },
      { current: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
    )
    expect(resolveChildRoute(parent, undefined))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
  })

  it('falls back to the parent route when the installed default is cleared', () => {
    const parent = parentOf({ provider: 'deepseek-official', model: 'deepseek-chat' }, { current: undefined })
    expect(resolveChildRoute(parent, undefined))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('prefers an explicit request override per field over the session default', () => {
    const parent = parentOf(
      { provider: 'deepseek-official', model: 'deepseek-chat' },
      { current: { provider: 'other', model: 'other-model' } },
    )
    expect(resolveChildRoute(parent, { model: 'explicit-model' }))
      .toEqual({ provider: 'other', model: 'explicit-model' })
    expect(resolveChildRoute(parent, { provider: 'explicit', model: 'explicit-model' }))
      .toEqual({ provider: 'explicit', model: 'explicit-model' })
  })
})

describe('resolveChildAgentOptions()', () => {
  it('routes through the tiers while inheriting maxTokens and stamping depth', () => {
    const parent = parentOf(
      { provider: 'deepseek-official', model: 'deepseek-chat', maxTokens: 4096 },
      { current: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
    )
    expect(resolveChildAgentOptions(parent, undefined, 2)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      maxTokens: 4096,
      subagentDepth: 2,
    })
    expect(resolveChildAgentOptions(parent, { maxTokens: 1024 }, 2)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-reasoner',
      maxTokens: 1024,
      subagentDepth: 2,
    })
  })
})
