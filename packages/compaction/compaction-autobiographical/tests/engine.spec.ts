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
import type { SummaryEntry } from '@animalabs/context-manager'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
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

  it('owns a fold by the turn and step the pass is preparing', async () => {
    const { engine, agent, session } = build(30, 'engine-auto-owner', { auto: true })
    const events = agentEvents(contextOf(engine), asAgent(session, agent.options))
    // One pass opens the runtime and seeds its store; the recollection and the
    // resolution below are what make the stepped pass below land a fold rather
    // than plan one for the tick to mint first.
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await (engine as unknown as {
      runtimes: Map<string, Promise<{
        strategy: { summaries: unknown[]; resolutions: Map<string, number> }
        store: { getStateJson(id: string): { id: string }[] }
      }>>
    }).runtimes.get(session.id)
    const stored = runtime!.store.getStateJson('messages').slice(0, 2)
    const ids = stored.map(message => message.id)
    runtime!.strategy.summaries.push({
      id: 'L1-70',
      level: 1,
      content: 'content of L1-70',
      tokens: 5,
      created: 0,
      sourceLevel: 0,
      sourceIds: ids,
      sourceRange: { first: ids[0] as string, last: ids.at(-1) as string },
    })
    for (const id of ids) runtime!.strategy.resolutions.set(id, 1)

    await events.waterfall(
      'agent/pre-step',
      { messages: [], turn: 30, step: 7, signal: SIGNAL },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    // A fold lands before the step it was planned for starts, so its owner comes
    // from the payload: the log holds no open turn to name, and a bracket left
    // holding the newest closed turn is one no turn boundary can close.
    const start = session.events.filter(event => event.type === 'compaction/start').at(-1)
    expect(start?.data).toMatchObject({ turn: 30 })
    const node = session.events.filter(event => event.type === 'assistant/message'
      && event.data.message.source.compactionId !== undefined).at(-1)
    expect(node?.data).toMatchObject({ turn: 30, step: 7 })
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
  it('drops the runtime it opened when the session is disposed', async () => {
    const { engine, agent } = build(30, 'engine-dispose')

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    // The session can only be released once its runtime exists, and opening is
    // what puts it in the map the disposal edge is keyed on.
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(runtimes(engine).size).toBe(1)

    contextOf(engine).emit('session/disposed', agent.session as never)
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

/** One merge-quarantine record, as the engine writes it when a run exhausts its attempts. */
type QuarantineRecord = {
  key: string
  level: number
  sourceIds: string[]
  attempts: number
  lastOutcome: string
  lastStopReason?: string
  quarantinedAt: number
}

/** The quarantine surface of a session's opened runtime, reached as `runtimes` is. */
async function quarantineSurface(engine: AutobiographicalCompactionEngine, sessionId: string): Promise<{
  getMergeQuarantineStatus(): { records: QuarantineRecord[] }
  mergeQuarantine: Map<string, QuarantineRecord>
  summaries: SummaryEntry[]
  store: { getStateJson(id: string): { id: string }[] }
}> {
  const opened = await (engine as unknown as {
    runtimes: Map<string, Promise<{
      strategy: {
        getMergeQuarantineStatus(): { records: QuarantineRecord[] }
        mergeQuarantine: Map<string, QuarantineRecord>
        summaries: SummaryEntry[]
      }
      store: { getStateJson(id: string): { id: string }[] }
    }>>
  }).runtimes.get(sessionId)
  const { strategy, store } = opened!
  // The surface is rebuilt rather than spread: both fields beside the method are
  // what the spec reaches, and spreading an instance drops the prototype the
  // method lives on.
  return {
    getMergeQuarantineStatus: () => strategy.getMergeQuarantineStatus(),
    mergeQuarantine: strategy.mergeQuarantine,
    summaries: strategy.summaries,
    store,
  }
}

describe('work a cancelled turn left behind', () => {
  it('retries a run an aborted turn quarantined, and leaves a refusal quarantined', async () => {
    const { engine, agent, session } = build(6, 'engine-quarantine')
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    const runtime = await quarantineSurface(engine, session.id)
    // A quarantined record survives only while its sources exist unmerged: the
    // engine's own sweep clears a record whose run it can no longer find, which
    // would empty the map without the lift being what did it. Anchoring both
    // records on one real, unmerged recollection is what makes them live debt.
    const [first, last] = runtime.store.getStateJson('messages').map(message => message.id)
    runtime.summaries.push({
      id: 'L3-90',
      level: 3,
      content: 'content of L3-90',
      tokens: 5,
      created: 0,
      sourceLevel: 2,
      sourceIds: [first as string, last as string],
      sourceRange: { first: first as string, last: last as string },
    })
    const record = (key: string, lastStopReason: string): QuarantineRecord => ({
      key, level: 2, sourceIds: ['L3-90'], attempts: 5,
      lastOutcome: lastStopReason === 'abort' ? 'unusable_empty' : 'refusal',
      lastStopReason, quarantinedAt: 0,
    })
    runtime.mergeQuarantine.set('aborted', record('aborted', 'abort'))
    runtime.mergeQuarantine.set('refused', record('refused', 'refusal'))
    const keys = (): string[] => runtime.getMergeQuarantineStatus().records.map(entry => entry.key)

    // A pass with no newer user message is the same conversation still running, so
    // the run stays out of the queue instead of being retried on every step: the
    // quarantine is the hold-off, and no pass lifts it by itself.
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(keys()).toEqual(['aborted', 'refused'])

    // The next user message is the chat resuming. An abort is the turn going away
    // rather than an answer about that ground, so releasing it costs nothing but a
    // retry; a refusal is the model's answer about the same ground, and retrying it
    // would buy the same verdict.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'carry on' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)

    expect(keys()).toEqual(['refused'])
  })

  it('kicks no tick under the signal a step was cancelled with', async () => {
    const { engine, agent, calls } = build(30, 'engine-cancelled-step', { auto: true })
    const events = agentEvents(contextOf(engine), asAgent(agent.session, agent.options))
    const step = (signal: AbortSignal): Promise<unknown> => events.waterfall(
      'agent/pre-step',
      { messages: [], turn: 30, step: 0, signal },
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    // The pass runs either way; what a dead signal costs is the tick, whose calls
    // would all abort on arrival while the engine counts every one of them as a
    // rejection of the work it was retrying.
    await step(AbortSignal.abort())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toEqual([])

    // The same step with a live signal is what proves the guard and not an empty
    // queue kept the first one quiet.
    await step(new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('memory formation on a dead transport', () => {
  /** Wait out the tick chain the last pass kicked. */
  async function ticks(engine: AutobiographicalCompactionEngine, sessionId: string): Promise<void> {
    const opened = await runtimes(engine).get(sessionId)
    await (opened as { tickChain: Promise<void> }).tickChain
  }

  /** The chunk-quarantine count of a session's open runtime. */
  async function chunkQuarantine(engine: AutobiographicalCompactionEngine, sessionId: string): Promise<number> {
    const opened = await runtimes(engine).get(sessionId)
    return (opened as {
      strategy: { getCompressionQuarantineStatus(): { count: number } }
    }).strategy.getCompressionQuarantineStatus().count
  }

  it('never quarantines on a transport failure, and folds once the connection is back', async () => {
    let healthy = false
    const { engine, agent, session } = build(30, 'engine-transport-down', {}, undefined, {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        void options
        if (!healthy) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'connection refused' } } }
          return
        }
        const text = 'memory: the agent asked and was answered.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })

    // While the transport is down the bridge throws, the tick rejects, and the
    // chunk stays queued: no pass spends an attempt budget against it and
    // nothing is quarantined.
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await ticks(engine, session.id)
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await ticks(engine, session.id)
    expect(await chunkQuarantine(engine, session.id)).toBe(0)

    // The connection's return is the retry: the queued span compresses and the
    // fold lands without anything having been cleared by hand.
    healthy = true
    const { result } = await settle(engine, agent)
    expect(result?.compactionId).toMatch(/^autobio:L1-/)
    expect(await chunkQuarantine(engine, session.id)).toBe(0)
  })

  it('lifts a quarantine written when a fallback rung died mid-tick on transport', async () => {
    const calls: GenerateOptions[] = []
    const { engine, agent, session } = build(30, 'engine-transport-ladder', {
      // The source-only rung gives the fallback ladder a second call to die on;
      // with no recall frontier the curve-variant rungs plan empty.
      strategy: { recentWindowTokens: 0, compressionSourceOnlyFallback: true },
    }, undefined, {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        // The canonical call's abort is a verdict-shaped stop, so the library
        // climbs its fallback ladder; the rung after it dies on the connection.
        yield {
          type: 'finish',
          reason: calls.length === 1
            ? { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn went away' } }
            : { kind: 'error', failure: { code: 'TRANSPORT', message: 'connection refused' } },
        }
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await ticks(engine, session.id)

    // The ladder's own bookkeeping would have retired the span — the rung scored
    // a provider error and the budget ran out — but the tick that wrote the
    // quarantine also saw the transport failure, so the record is lifted and the
    // span retries on the next pass.
    expect(warn.mock.calls.some(([line]) => String(line).includes('released a chunk quarantine'))).toBe(true)
    expect(await chunkQuarantine(engine, session.id)).toBe(0)
  })

  it('keeps a quarantine the model\'s own verdicts earned', async () => {
    const { engine, agent, session } = build(30, 'engine-abort-quarantine', {}, undefined, {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn went away' } } }
      },
    })

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await ticks(engine, session.id)

    // Same ladder, same exhaustion, but the tick saw no transport failure: the
    // record stays. This is the control — it proves the fixture really drives a
    // chunk to quarantine, so the zero above means the lift did it.
    expect(await chunkQuarantine(engine, session.id)).toBe(1)
  })
})
