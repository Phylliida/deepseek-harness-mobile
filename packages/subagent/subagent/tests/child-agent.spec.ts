/**
 * Child route tiers (`resolveChildRoute`): an explicit per-request override,
 * else the delegating agent's subagent override (`subagentModelOverrideFor`),
 * else the parent's own route — and `resolveChildAgentOptions` carrying
 * maxTokens and depth independently of that tiering.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import {
  resolveChildAgentOptions, resolveChildRoute, subagentModelOverrideFor, type SubagentModelOverride,
} from '../src/child-agent.ts'

/** Minimal parent: AgentOptions plus its override holder, when the case installs one. */
function parentOf(options: AgentOptions, override?: SubagentModelOverride): Agent {
  const parent = { options, ctx: new Context() } as unknown as Agent
  if (override !== undefined) subagentModelOverrideFor(parent).current = override.current
  return parent
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

  it('keeps one agent\'s override invisible to another agent', () => {
    const first = parentOf(
      { provider: 'deepseek-official', model: 'deepseek-chat' },
      { current: { provider: 'other', model: 'other-model' } },
    )
    const second = parentOf({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(resolveChildRoute(second, undefined))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(resolveChildRoute(first, undefined))
      .toEqual({ provider: 'other', model: 'other-model' })
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
