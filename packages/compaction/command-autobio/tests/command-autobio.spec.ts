import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import AutobiographicalCompactionEngine from '@deepseek-ai/dsh-compaction-autobiographical'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandAutobio from '@deepseek-ai/dsh-command-autobio'

/** A different provider for the same seam: the command must refuse to drive it. */
class ForeignCompactionEngine extends CompactionEngine {
  override compactIfNeeded(
    _agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactNow(
    _agent: ManualCompactAgentContext,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new Error('unused'))
  }
}

interface Harness {
  readonly ctx: Context
  readonly engine: AutobiographicalCompactionEngine
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** A context carrying the real backend plus the registered command. */
async function harness(auto = true): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  const engine = new AutobiographicalCompactionEngine(ctx, { auto })
  const plugin = await ctx.plugin(commandAutobio)
  const agent = { session: Session.create(SessionId('command-autobio')), options: {} } as unknown as Agent
  return { ctx, engine, agent, plugin }
}

async function run(suffix = ''): Promise<CommandResult> {
  const test = await harness()
  const execution = await test.ctx.commands.execute(test.agent, `/autobio${suffix}`, new AbortController().signal)
  if (execution === undefined) throw new Error('the autobio command was not registered')
  return execution.result
}

describe('@deepseek-ai/dsh-command-autobio registration', () => {
  it('registers one toggling command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandAutobio.name).toBe('command-autobio')
    expect(commandAutobio.inject).toEqual(['commands', 'compaction'])
    expect('default' in commandAutobio).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandAutobio)).toBe(commandAutobio)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'autobio',
      description: 'Turn autobiographical memory folding on or off',
      input: { hint: '[on|off|status]' },
    })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'autobio')).toBeUndefined()
  })

  it('reports the folding state for an argument-free or explicit status request', async () => {
    expect(await run()).toEqual({
      kind: 'success',
      text: 'Autobiographical folding is on: aged history folds into recollections at every step boundary.',
    })
    expect(await run(' status')).toEqual({
      kind: 'success',
      text: 'Autobiographical folding is on: aged history folds into recollections at every step boundary.',
    })
  })

  it('reports folding off for a backend constructed without automatic registration', async () => {
    const test = await harness(false)
    const execution = await test.ctx.commands.execute(
      test.agent,
      '/autobio status',
      new AbortController().signal,
    )
    expect(execution?.result).toEqual({
      kind: 'success',
      text: 'Autobiographical folding is off: the engine forms no memories on its own. '
        + '/compact and other explicit requests still fold.',
    })
  })
})

describe('/autobio human command', () => {
  it('turns automatic folding off and back on, reporting the state it left behind', async () => {
    const test = await harness()
    const session = test.agent.session

    const off = await test.ctx.commands.execute(test.agent, '/autobio off', new AbortController().signal)
    expect(off?.result).toEqual({
      kind: 'success',
      text: 'Autobiographical folding is off: the engine forms no memories on its own. '
        + '/compact and other explicit requests still fold.',
    })
    expect(test.engine.isAutomaticFoldingEnabled).toBe(false)

    // Case and padding are the human's business, not the parser's.
    const on = await test.ctx.commands.execute(test.agent, '/autobio  ON ', new AbortController().signal)
    expect(on?.result).toEqual({
      kind: 'success',
      text: 'Autobiographical folding is on: aged history folds into recollections at every step boundary.',
    })
    expect(test.engine.isAutomaticFoldingEnabled).toBe(true)
    // Toggling is not conversation: neither state change reaches the model.
    expect(session.surface.nodes).toEqual([])
    expect(session.deriveMessages()).toEqual([])
  })

  it('rejects an unknown argument with the usage line', async () => {
    expect(await run(' maybe')).toEqual({
      kind: 'error',
      text: 'Usage: /autobio [on|off|status]',
    })
  })

  it('refuses to drive a compaction backend that is not the autobiographical engine', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    new ForeignCompactionEngine(ctx)
    await ctx.plugin(commandAutobio)
    const agent = { session: Session.create(SessionId('command-autobio-foreign')), options: {} } as unknown as Agent

    const execution = await ctx.commands.execute(agent, '/autobio off', new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'The loaded compaction backend is not the autobiographical engine; nothing to toggle.',
    })
  })
})
