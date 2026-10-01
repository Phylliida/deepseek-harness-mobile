/**
 * Lifecycle surfaces a pass-driven spec never reaches: the manual entry point,
 * the step-boundary listener the engine registers, and what happens to an open
 * runtime when the agent that owns it goes away.
 *
 * The failure these guard is silent. Nothing crashes when a runtime outlives its
 * session — the engine simply keeps a seeded store in a map and hands it to the
 * next pass, which is why the assertions read the engine's own calls rather than
 * a mock's bookkeeping.
 */

import { ContextManager } from '@animalabs/context-manager'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutobiographicalCompactionEngine } from '../src/index.ts'
import { build, contextOf, settle, transcript } from './harness.ts'

/** The engine's open runtimes, reached past the private map a pass holds them in. */
function runtimes(engine: AutobiographicalCompactionEngine): Map<string, Promise<unknown>> {
  return (engine as unknown as { runtimes: Map<string, Promise<unknown>> }).runtimes
}

/** The strategy behind a session's runtime, opened if the engine has not yet. */
async function runtimeStrategy(engine: unknown, agent: unknown): Promise<{ reportRealInputTokens(n: number): void }> {
  const opened = (engine as {
    runtimeFor: (a: unknown, r: { provider: string; model: string }) => Promise<{
      strategy: { reportRealInputTokens(n: number): void }
    }>
  }).runtimeFor(agent, { provider: 'test', model: 'test-model' })
  return (await opened).strategy
}

const SIGNAL = new AbortController().signal

afterEach(() => {
  vi.restoreAllMocks()
})

/** The engine reaches an agent only through these two fields. */
function asAgent(session: unknown, options: unknown): Agent {
  return { session, options } as unknown as Agent
}

describe('manual compaction entry points', () => {
  it('folds inside the maintenance claim, not around it', async () => {
    const { engine, agent } = build(30, 'engine-manual')
    let claimed = 0
    const maintenance = {
      ...agent,
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        claimed += 1
        return task(SIGNAL)
      },
    }

    const { result } = await settle(
      engine,
      maintenance,
      (_context, signal) => engine.compactNow(maintenance, signal),
    )

    // The claim is what keeps manual work from racing the loop, so a fold that
    // reached the log outside it would be the bug this case exists to catch.
    expect(claimed).toBeGreaterThan(0)
    expect(result?.compactionId).toMatch(/^autobio:L1-/)
    expect(agent.session.events.some(event => event.type === 'compaction/end')).toBe(true)
  })

  it('refuses an explicit range instead of folding one', async () => {
    const { engine, agent } = build(2, 'engine-region')

    const error = await engine.compactRegion(0, 4, agent, SIGNAL).then(
      () => { throw new Error('expected a rejection') },
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('summary')
  })
})

describe('automatic folding at a step boundary', () => {
  it('folds before the request is derived', async () => {
    const { engine, agent } = build(30, 'engine-auto', { auto: true })
    const events = agentEvents(contextOf(engine), asAgent(agent.session, agent.options))
    const before = agent.session.events.length
    const step = async (): Promise<void> => {
      await events.waterfall(
        'agent/pre-step',
        { messages: [], turn: 30, step: 0, signal: SIGNAL },
        async () => ({ kind: 'enter' as const, messages: [] }),
      )
    }

    // The listener folds before deriving the request, so a settled pass count is
    // reached entirely through step boundaries — the same way a real turn does.
    for (let stepNumber = 0; stepNumber < 6; stepNumber++) await step()

    expect(agent.session.events.length).toBeGreaterThan(before)
    expect(agent.session.events.some(event => event.type === 'compaction/end')).toBe(true)
  })

  it('keeps the turn standing when folding fails', async () => {
    const { engine } = build(30, 'engine-auto-throws', { auto: true })
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A session whose events cannot be replayed is the cheapest real failure to
    // reach here, and it is enough: the listener has to contain it, because a
    // fold that cannot run must never become the reason a turn ends.
    const broken = { session: transcript('engine-broken', 2), options: undefined }
    Object.defineProperty(broken.session, 'events', {
      get() { throw new Error('log went away') },
    })

    const decision = await agentEvents(contextOf(engine), asAgent(broken.session, broken.options)).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('folding failed: log went away'))
  })
})

describe('runtime lifetime', () => {
  it('drops the runtime it opened when the agent is disposed', async () => {
    const { engine, agent } = build(30, 'engine-dispose')
    const agent1 = asAgent(agent.session, agent.options)

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    // The session can only be released once its runtime exists, and opening is
    // what puts it in the map the disposal edge is keyed on.
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(runtimes(engine).size).toBe(1)

    agentEvents(contextOf(engine), agent1).emit('agent/disposed', {})
    await vi.waitFor(() => { expect(runtimes(engine).size).toBe(0) })

    // A later pass re-seeds from the log rather than reusing what disposal took
    // away, which is the whole point of the runtime being disposable.
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(runtimes(engine).size).toBe(1)
  })

  it('does not cache a runtime whose open failed', async () => {
    const { engine, agent } = build(30, 'engine-open-fails')
    const open = vi.spyOn(ContextManager, 'open').mockRejectedValueOnce(new Error('library is down'))

    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).rejects.toThrow('library is down')

    // A rejected open left in the cache would fail that session forever: every
    // later pass would await the same rejection instead of trying again, and the
    // failure that reaches here — an unrouted session — is one the next step
    // boundary fixes. So the entry has to be gone before the next pass looks.
    expect(open).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(runtimes(engine).size).toBe(0) })

    open.mockRestore()
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(runtimes(engine).size).toBe(1)
  })
})

describe('calibration', () => {
  it('reports the last step\'s real prompt size on the first pass', async () => {
    const { engine, agent } = build(30, 'engine-calibration')
    const reported = vi.spyOn(await runtimeStrategy(engine, agent), 'reportRealInputTokens')

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)

    // The step the fixture just ran is the one whose usage is reported, and it
    // has to happen on the first pass: an estimator that waits for a second pass
    // prices the first fold by a guess it was already handed the answer to.
    expect(reported).toHaveBeenCalledWith(1000)
  })

  it('reports a step once rather than once per pass', async () => {
    const { engine, agent } = build(30, 'engine-calibration-once')
    const reported = vi.spyOn(await runtimeStrategy(engine, agent), 'reportRealInputTokens')

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)

    // A pass that appends nothing new finds no unreported usage, so the mark has
    // to survive the pass that fed it.
    expect(reported).toHaveBeenCalledTimes(1)
  })
})
