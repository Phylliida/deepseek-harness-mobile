/**
 * The engine's own edges: the budget and the compile that consumes it, the tool
 * schemas it pushes into the strategy, the log events it mirrors after a pass
 * has already run, and what happens to an open runtime when its session is
 * disposed or the plugin unloads.
 *
 * These are the surfaces a fold-driven spec never reaches, and every one of them
 * fails quietly: a session that never pushed its tools simply never folds, and a
 * runtime that outlives its session is invisible until the map it sits in is read
 * again.
 */

import { ContextManager, OverBudgetError } from '@animalabs/context-manager'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutobiographicalCompactionEngine from '../src/index.ts'
import type { ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { build, contextOf, provideTokenMeter, settle, summarizer } from './harness.ts'

/** Let the fire-and-forget tick chain finish. It is never awaited by a pass. */
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** An open runtime: the strategy it holds and the manager a pass compiles through. */
interface OpenRuntime {
  strategy: {
    summaries: unknown[]
    tick(): Promise<void>
    store: { getStateJson(id: string): unknown[] }
    /** The committed resolutions the planner reads a fold's ground from. */
    resolutions: Map<string, number>
    /** Message ids the picker leaves at the frontier they were resolved under. */
    locked: Set<string>
  }
  manager: { compile(budget: unknown): Promise<unknown> }
  /** Log seq behind each mirrored message id, as the runtime keeps it. */
  seqOf: Map<string, number>
  /** Highest log seq the cursor has mirrored into the store. */
  walked: number
  /** The attempt counter this runtime has reached, and the count the log reports. */
  progress: { attempt: number }
  recorded: number
}

/** The engine's open runtimes, reached past the private map a pass holds them in. */
function runtimes(engine: AutobiographicalCompactionEngine): Map<string, Promise<OpenRuntime>> {
  return (engine as unknown as { runtimes: Map<string, Promise<OpenRuntime>> }).runtimes
}

function events(session: Session, type: string): unknown[] {
  return session.events.filter(event => event.type === type)
}

/** An agent the engine will accept, over a session the test built by hand. */
function asAgent(
  session: Session,
  options: Record<string, unknown>,
): ManualCompactAgentContext {
  return {
    session,
    options,
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      task(new AbortController().signal),
  }
}

/** A budget refusal carrying the shape the library throws, built without the picker. */
function overBudget(budget: number, actual: number): OverBudgetError {
  return new OverBudgetError({
    budget,
    actual,
    diagnostics: { headTokens: 0, tailTokens: 0, middleTokens: actual, middleChunkCount: 1, deepestLevel: 1 },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the compile budget', () => {
  it('compiles against the operating window less the response reserve', async () => {
    const { engine, agent } = build(30, 'index-budget')
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    await engine.compactNow(agent, new AbortController().signal)

    expect(compile.mock.calls.at(0)?.[0]).toEqual({ maxTokens: 572, reserveForResponse: 128 })
  })

  it('prefers the configured operating window over the one the route advertises', async () => {
    const { engine, agent } = build(30, 'index-budget-configured', { operatingWindowTokens: 800, reserveTokens: 100 })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    await engine.compactNow(agent, new AbortController().signal)

    expect(compile.mock.calls.at(0)?.[0]).toEqual({ maxTokens: 700, reserveForResponse: 100 })
  })

  it('passes on a session whose route advertises no window', async () => {
    // No `request/context`, so there is no window to compute a budget from. The
    // compromise is that the route has to come from the options instead.
    const session = Session.create(SessionId('index-no-window'))
    const { engine } = build(0, 'index-no-window')
    const agent = asAgent(session, { provider: 'test', model: 'test-model' })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    expect(compile).not.toHaveBeenCalled()
  })

  it('passes on a session that has not routed a model', async () => {
    const session = Session.create(SessionId('index-unrouted'))
    const { engine } = build(0, 'index-unrouted')

    expect(await engine.compactNow(asAgent(session, {}), new AbortController().signal)).toBeNull()
  })

  it('passes on options that name only half a route', async () => {
    // A header carries no route of its own, so the route comes from
    // `requestContext` — and a logged context naming half a route is not a route.
    const session = Session.create(SessionId('index-half-route'))
    session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
    const { engine } = build(0, 'index-half-route')

    expect(await engine.compactNow(asAgent(session, { provider: 'test' }), new AbortController().signal)).toBeNull()
    expect(await engine.compactNow(asAgent(session, { provider: '', model: 'test-model' }), new AbortController().signal)).toBeNull()
  })

  it('passes on a window no larger than the reserve leaves no room in', async () => {
    // A budget of zero or less is not a small budget to fold with, it is no budget:
    // the pass must refuse before it opens a runtime, because the manager refuses
    // to compile at all in this shape and the refusal would arrive as a throw.
    const session = Session.create(SessionId('index-no-room'))
    session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 64 })
    const { engine } = build(0, 'index-no-room', { reserveTokens: 64 })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    expect(await engine.compactNow(asAgent(session, {}), new AbortController().signal)).toBeNull()
    expect(compile).not.toHaveBeenCalled()
    // No runtime either: a refused pass leaves nothing open behind it.
    expect(runtimes(engine).size).toBe(0)
  })
})

describe('the session\'s own memory settings', () => {
  it('compiles against the window the session\'s log sets', async () => {
    const { engine, agent, session } = build(30, 'index-settings-window')
    session.append('compaction/config', { operatingWindowTokens: 800 })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    await engine.compactNow(agent, new AbortController().signal)

    expect(compile.mock.calls.at(0)?.[0]).toEqual({ maxTokens: 672, reserveForResponse: 128 })
  })

  it('drops the window override when the log clears it', async () => {
    const { engine, agent, session } = build(30, 'index-settings-cleared')
    session.append('compaction/config', { operatingWindowTokens: 800 })
    session.append('compaction/config', { operatingWindowTokens: null })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    await engine.compactNow(agent, new AbortController().signal)

    expect(compile.mock.calls.at(0)?.[0]).toEqual({ maxTokens: 572, reserveForResponse: 128 })
  })

  it('folds nothing while the session\'s memory is paused, and resumes when it lifts', async () => {
    const { engine, agent, session } = build(30, 'index-settings-paused')
    session.append('compaction/config', { enabled: false })
    const compile = vi.spyOn(ContextManager.prototype, 'compile')

    // The pause is the whole pass: no compile, no tick, and the log untouched.
    const events = session.events.length
    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    expect(compile).not.toHaveBeenCalled()
    expect(session.events.length).toBe(events)

    session.append('compaction/config', { enabled: true })
    await engine.compactNow(agent, new AbortController().signal)
    expect(compile).toHaveBeenCalled()
  })
})

describe('compiling against a refusal', () => {
  it('does not fold when the retry refuses too', async () => {
    const { engine, agent, session } = build(30, 'index-refuse-twice')
    // The real compile refuses on tokens the fixture planned, which would mask
    // the refusal this test is about. A pass only reads the result for truth.
    const compile = vi.spyOn(ContextManager.prototype, 'compile')
      .mockImplementation(async (_budget) => {
        throw overBudget(_budget?.maxTokens ?? 0, 600)
      })

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    // One refusal retries at what the refusal said it needed; the second gives up.
    expect(compile).toHaveBeenCalledTimes(2)
    expect(compile.mock.calls.at(1)?.[0]).toEqual({ maxTokens: 728, reserveForResponse: 128 })
    expect(events(session, 'compaction/start')).toEqual([])
  })

  it('retries at the floor a refusal reports, and warns in the refusal\'s own units', async () => {
    const { engine, agent } = build(30, 'index-refuse-floor')
    // A refusal reports its floor against the library's usable budget — the total
    // less the response allowance — so a floor below the total is still a floor
    // above the budget that refused, and the retry claims exactly that floor.
    const compile = vi.spyOn(ContextManager.prototype, 'compile')
      .mockImplementationOnce(async (asked) => {
        throw overBudget((asked?.maxTokens ?? 0) - 128, 100)
      })
      .mockImplementationOnce(async (asked) => {
        throw overBudget((asked?.maxTokens ?? 0) - 128, (asked?.maxTokens ?? 0) - 98)
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    expect(compile.mock.calls.at(1)?.[0]).toEqual({ maxTokens: 228, reserveForResponse: 128 })
    // Both numbers in the warning are the refusal's own: `actual` is a
    // usable-budget figure, so it is printed against the usable budget it was
    // measured against rather than the total the pass asked for.
    expect(warn.mock.calls.flat().join('\n')).toContain('folding is 130 tokens over budget 100')
  })

  it('reports a compile failure that is not a refusal as an expected one', async () => {
    const { engine, agent } = build(30, 'index-compile-broke')
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async () => {
      throw new Error('the store went away')
    })

    // `/compact` reports a classified failure to its caller and rethrows
    // anything else as an unexpected one, so a store fault has to arrive
    // classified rather than as a crash the command adapter cannot place.
    const error = await engine.compactNow(agent, new AbortController().signal)
      .then(() => { throw new Error('expected a rejection') }, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('summary')
    expect((error as ManualCompactionError).message).toContain('the store went away')
  })

  it('warns and folds again next step when the retry is still over budget', async () => {
    const { engine, agent } = build(30, 'index-over-budget')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async (_budget) => {
      const budget = _budget ?? { maxTokens: 0, reserveForResponse: 0 }
      // Over budget yet again, but only just: the next pass will not be.
      throw overBudget(budget.maxTokens - 128, budget.maxTokens - 118)
    })

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    expect(warn.mock.calls.some(([line]) => String(line).includes('over budget'))).toBe(true)
  })
})

describe('tool definitions', () => {
  it('hands the strategy the tools the session declared', async () => {
    const { engine, agent, session } = build(30, 'index-tools')
    session.append('request/header', {
      header: {
        config: { provider: 'test', model: 'test-model' },
        tools: [{
          name: 'now',
          description: 'The time.',
          parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
        }],
      },
      reason: 'initial',
    })
    const set = vi.spyOn(ContextManager.prototype, 'setToolDefinitions')

    await engine.compactNow(agent, new AbortController().signal)

    // The strategy reads `inputSchema`; the session declares JSON Schema.
    expect(set.mock.calls.at(-1)?.[0]).toEqual([
      {
        name: 'now',
        description: 'The time.',
        inputSchema: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
      },
    ])
  })

  it('omits the schema keys a tool does not declare', async () => {
    const { engine, agent, session } = build(30, 'index-tools-sparse')
    session.append('request/header', {
      header: {
        config: { provider: 'test', model: 'test-model' },
        tools: [{ name: 'bare', description: 'Declares nothing.', parameters: { type: 'object' } }],
      },
      reason: 'initial',
    })
    const set = vi.spyOn(ContextManager.prototype, 'setToolDefinitions')

    await engine.compactNow(agent, new AbortController().signal)

    // Absent, not undefined: the strategy spreads this into the prompt.
    expect(set.mock.calls.at(-1)?.[0]).toEqual([
      { name: 'bare', description: 'Declares nothing.', inputSchema: { type: 'object' } },
    ])
  })

  it('leaves the strategy alone when the session declared no tools', async () => {
    const { engine, agent } = build(30, 'index-tools-none')
    const set = vi.spyOn(ContextManager.prototype, 'setToolDefinitions')

    await engine.compactNow(agent, new AbortController().signal)

    expect(set).not.toHaveBeenCalled()
  })

  it('pushes a declaration set the strategy already holds once, and the system voice with it', async () => {
    const { engine, agent, session } = build(30, 'index-declarations')
    const declared = (system: string) => ({
      config: { provider: 'test', model: 'test-model' },
      system,
      tools: [{ name: 'now', description: 'The time.', parameters: { type: 'object' } }],
    })
    session.append('request/header', { header: declared('you are the agent'), reason: 'initial' })
    const set = vi.spyOn(ContextManager.prototype, 'setToolDefinitions')
    const prompt = vi.spyOn(ContextManager.prototype, 'setSystemPrompt')

    await engine.compactNow(agent, new AbortController().signal)
    await engine.compactNow(agent, new AbortController().signal)

    // A pass runs at every step boundary while the header only changes when the
    // declarations do, so a pass that finds the same snapshot has nothing to push.
    expect(set).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('you are the agent')

    // The memory-writing call is served the session's own system voice, so a
    // change to it has to reach the strategy on the pass that sees it.
    session.append('request/header', { header: declared('you are the agent, and terse'), reason: 'change' })
    await engine.compactNow(agent, new AbortController().signal)

    expect(set).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenLastCalledWith('you are the agent, and terse')
  })

  it('pushes tools a session declared after its runtime was already open', async () => {
    const { engine, agent, session } = build(4, 'index-tools-late')
    await engine.compactNow(agent, new AbortController().signal)
    session.append('request/header', {
      header: {
        config: { provider: 'test', model: 'test-model' },
        tools: [{ name: 'now', description: 'The time.', parameters: { type: 'object', required: ['zone'] } }],
      },
      reason: 'change',
    })
    const set = vi.spyOn(ContextManager.prototype, 'setToolDefinitions')

    await engine.compactNow(agent, new AbortController().signal)

    // Re-pushing a definition set the strategy already has is free; missing one
    // means the strategy defers every chunk holding a tool block forever.
    expect(set.mock.calls.at(-1)?.[0]).toEqual([
      { name: 'now', description: 'The time.', inputSchema: { type: 'object', required: ['zone'] } },
    ])
  })
})

describe('memory formation behind the pass', () => {
  it('warns and still records when the tick fails', async () => {
    const calls: GenerateOptions[] = []
    const { engine, agent, session } = build(30, 'index-tick-failed', {}, undefined, {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'half a memory' }
        // A failure the bridge reads as an abort, which the strategy quarantines.
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the model hung up', code: 'SERVER' } } }
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await engine.compactNow(agent, new AbortController().signal)
    for (let i = 0; i < 50 && events(session, 'autobio/memory').length === 0; i += 1) await settled()

    // A failed call still happened, and a session that never hears about it has
    // no way to tell a broken summarizer from a session with nothing to say.
    expect(warn.mock.calls.some(([line]) => String(line).includes('ended'))).toBe(true)
    expect(events(session, 'autobio/memory').length).toBeGreaterThan(0)
  })

  it('records an attempt that no recollection accompanied', async () => {
    const { engine, agent, session } = build(30, 'index-tick-failed')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    expect(runtime).toBeDefined()
    const attempts = (): number[] =>
      events(session, 'autobio/memory').map(event => (event as { data: { attempt: number } }).data.attempt)
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    // A compression call that settled: the counter now stands past every count the
    // log holds, so the pass writes this one down.
    runtime!.progress.attempt += 1
    settle(runtime, session)
    expect(attempts().at(-1)).toBe(runtime!.progress.attempt)

    // A later pass with the counter where that record left it. It adds nothing:
    // writing the same attempt again on every pass would fill the log with copies
    // of itself, and a replay would read a count the session never reached.
    settle(runtime, session)
    expect(attempts()).toHaveLength(1)

    // A tick whose compression call settled and which then failed — the counter has
    // moved but no recollection came of it. This is the state that made the record
    // load-bearing: `appendMemory` returns early while the counter is still at the
    // count the log reports, so this writes the attempt down with no memory
    // attached, and a reopen learns where to continue instead of redoing the call.
    runtime!.progress.attempt += 1
    settle(runtime, session)

    expect(attempts()).toEqual([1, 2])
    expect(events(session, 'autobio/memory').at(-1)).not.toHaveProperty('data.memory')
  })

  it('resumes the counter from the newest record that names one', async () => {
    const session = Session.create(SessionId('index-bad-attempt'))
    session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
    // Records written before they carried a count, as the sessions on disk hold:
    // the field is absent rather than `undefined`, because the log's own boundary
    // refuses a value JSON cannot carry. Reading one as a count is what wedged a
    // live session: `Math.max(0, undefined)` is `NaN`, so the counter opened at
    // `NaN` and the record naming it could not cross that same boundary — the
    // session then failed to start at all.
    const stats = { chunksTotal: 0, chunksCompressed: 0, compressionCount: 0, l1: 0, l2: 0, l3: 0, pendingMerges: 0 }
    session.append('autobio/memory', { ...stats } as never)
    session.append('autobio/memory', { ...stats } as never)
    session.append('autobio/memory', { ...stats, attempt: 4 })
    const ctx = new Context()
    ctx.provide('llm', summarizer([]) as never)
    provideTokenMeter(ctx)
    const engine = new AutobiographicalCompactionEngine(ctx, {
      operatingWindowTokens: 700,
      reserveTokens: 128,
      auto: false,
      strategy: { recentWindowTokens: 0 },
    })
    const agent = {
      session,
      options: { provider: 'test', model: 'test-model' },
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
    } as ManualCompactAgentContext

    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)

    // The count the log can resume from, rather than one no record ever named.
    expect(runtime!.recorded).toBe(4)
    expect(runtime!.progress.attempt).toBe(4)
  })

  it('refuses to record a call whose counter is not a number', async () => {
    const { engine, agent, session } = build(30, 'index-nan-attempt')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const written = events(session, 'autobio/memory').length
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime!.progress.attempt = Number.NaN
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)
    settle(runtime, session)

    // A count the log cannot store is refused here rather than written, because the
    // record that carries it is the one a reopen seeds the counter from: storing it
    // would leave a session that opens on a counter it cannot be resumed from.
    expect(events(session, 'autobio/memory')).toHaveLength(written)
    expect(warn.mock.calls.flat().join('\n')).toContain('the counter is not a number')
  })

  it('refuses to write down a recollection whose ground is not in the store', async () => {
    const { engine, agent, session } = build(30, 'index-ungrounded')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    // A recollection distilled from a message the replayed store does not hold.
    // The engine cannot say which log span it stands for, and a replayed entry
    // citing nothing is rejected on the next open, so the recollection is dropped.
    runtime?.strategy.summaries.push({
      id: 'L1-9',
      level: 1,
      content: 'a memory with no ground in the log',
      tokens: 10,
      created: 0,
      sourceIds: ['record-that-never-was'],
    })

    await engine.compactNow(agent, new AbortController().signal)
    for (let i = 0; i < 50 && events(session, 'autobio/memory').length === 0; i += 1) await settled()

    // The recollection is dropped while the passes behind it still report: no
    // record anywhere names L1-9, and the passes that ran were written down.
    const records = events(session, 'autobio/memory') as { data: { memory?: { id: string } } }[]
    expect(records.some(({ data }) => data.memory?.id === 'L1-9')).toBe(false)
    expect(records.length).toBeGreaterThan(0)
  })

  it('reports that a refused record holds a value the log cannot store', async () => {
    const { engine, agent, session } = build(30, 'index-unstorable')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const written = events(session, 'autobio/memory').length
    // A recollection whose token count is not a number the log can store. The
    // mint reaches `append` through the tick chain, which nothing awaits: a throw
    // there is rejected work behind a turn, and the process dies with it.
    runtime?.strategy.summaries.push({
      id: 'L1-8',
      level: 1,
      content: `a memory priced at no number at all ${'y'.repeat(1_000)}`,
      tokens: Number.NaN,
      created: 0,
      sourceIds: ['ground-1'],
    })
    runtime!.seqOf.set('ground-1', 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    settle(runtime, session)

    // The console carries the log's own refusal, that the record held a value it
    // could not store at all, and the text it made of the record. `JSON.stringify`
    // rendered that `NaN` as `null`, and the log is left without a record rather
    // than with a wrong one.
    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('the memory record for attempt'))).toBe(true)
    expect(lines.some(line => line.includes('holds a value the session log cannot store'))).toBe(true)
    const data = lines.find(line => line.includes('data: {"chunksTotal"'))
    // One line's worth of the record, so a long recollection cannot flood the log.
    expect(data?.endsWith('…')).toBe(true)
    expect(data?.length).toBeLessThan(700)
    expect(events(session, 'autobio/memory')).toHaveLength(written)
  })

  it('announces a recollection only once its record is durable', async () => {
    const { engine, agent, session } = build(30, 'index-refused-announcement')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const written = events(session, 'autobio/memory').length
    runtime?.strategy.summaries.push({
      id: 'L1-6',
      level: 1,
      content: 'a memory the log refused once',
      tokens: 12,
      created: 0,
      sourceIds: ['ground-1'],
    })
    runtime!.seqOf.set('ground-1', 1)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    // The write refuses, so the recollection is not in the log and the record
    // naming it is not either.
    const refuse = vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('the log closed mid-write')
    })
    settle(runtime, session)
    expect(events(session, 'autobio/memory')).toHaveLength(written)

    // A recollection marked announced by a refused record is never announced
    // again, so the retry is the whole of what keeps it in the archive.
    refuse.mockRestore()
    settle(runtime, session)

    const records = events(session, 'autobio/memory') as { data: { memory?: { id: string } } }[]
    expect(records.some(({ data }) => data.memory?.id === 'L1-6')).toBe(true)
  })

  it('says so when the record itself is storable and the refusal came from elsewhere', async () => {
    const { engine, agent, session } = build(30, 'index-refused-elsewhere')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    runtime!.progress.attempt += 1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(session, 'append').mockImplementation(() => {
      throw new Error('the log closed mid-write')
    })
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    settle(runtime, session)

    // Every value in the record is one the log stores, so the report names no
    // offender — a refusal with no offending value is a different bug, and the
    // report must not blur the two.
    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('the log closed mid-write'))).toBe(true)
    expect(lines.some(line => line.includes('holds a value the session log cannot store'))).toBe(false)
    expect(lines.some(line => line.includes('data: {"chunksTotal"'))).toBe(true)
  })

  /** A summarizer that streams `text` in two deltas and then stops. */
  const streaming = (text: string) => ({
    async *stream(): AsyncIterable<StreamChunk> {
      if (text !== '') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: text.slice(0, 800) }
        yield { type: 'text-delta', index: 0, text: text.slice(800) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  /** The live records of the first bridge call, as the chat row reads them. */
  function progressOf(session: Session, attempt: number): [number, boolean | undefined][] {
    return (events(session, 'autobio/memory-progress') as {
      data: { attempt: number; delta: string; done?: boolean }
    }[])
      .filter(event => event.data.attempt === attempt)
      .map(event => [event.data.delta.length, event.data.done])
  }

  it('flushes what a recollection streams mid-call and closes it on the terminal flush', async () => {
    const { engine, agent, session } = build(30, 'index-progress', {}, undefined, streaming('x'.repeat(1_200)))
    await engine.compactNow(agent, new AbortController().signal)
    for (let i = 0; i < 50 && progressOf(session, 1).length < 2; i += 1) await settled()

    // One record per buffered flush rather than one per streamed chunk: the first
    // carries the text the row streams, the second closes the call with nothing
    // left to carry. Both report the attempt the settling tick record will too.
    expect(progressOf(session, 1)).toEqual([[1_200, undefined], [0, true]])
    // The tick record that settles the call reports the same attempt, which is
    // what lets one chat row hold both.
    expect((events(session, 'autobio/memory') as { data: { attempt: number } }[])[0]?.data.attempt).toBe(1)
  })

  it('writes no live record for a call that streamed no text', async () => {
    const { engine, agent, session } = build(30, 'index-progress-empty', {}, undefined, streaming(''))
    await engine.compactNow(agent, new AbortController().signal)
    await settled()

    // Nothing streamed, so the call formed no memory: it takes no attempt number
    // and leaves no record for a chat row to claim.
    expect(events(session, 'autobio/memory-progress')).toHaveLength(0)
    expect(events(session, 'autobio/memory')).toHaveLength(0)
  })
})

describe('mirroring the log after a runtime is open', () => {
  it('hands the strategy the messages the log gained', async () => {
    const { engine, agent, session } = build(4, 'index-late-append')
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    const runtime = await runtimes(engine).get(session.id)
    const stored = runtime!.strategy.store.getStateJson('messages').length
    const before = session.surface.nodes.length

    // Both events land after the runtime is open and before the pass that mirrors
    // them: one the cursor writes, one it must walk past. A usage-only step is an
    // append surface event that derives no message, so skipping it is the whole
    // reason the walk is not simply "append what arrived".
    session.append('assistant/message', {
      turn: 99,
      step: 0,
      message: createAssistantMessage({ content: [], source: { provider: 'test', model: 'test-model' } }),
      usage: { inputTokens: 7, outputTokens: 0 },
    }, { surfaceOp: 'append' })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'a later ask' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    const landed = session.events.at(-1)!
    expect(landed.type).toBe('user/message')

    // Rewound, because a pass may re-open the runtime: a fresh one replays the
    // log and arrives with the appended message already in the store, which would
    // make the assertions below pass without the cursor ever moving. This is the
    // only way to pin the live walk rather than a replay that happens to agree.
    runtime!.walked = landed.seq - 2

    await engine.compactNow(agent, new AbortController().signal)

    expect(session.surface.nodes.length).toBe(before + 2)
    expect(runtime!.walked).toBe(landed.seq)
    expect(runtime!.strategy.store.getStateJson('messages').length).toBe(stored + 1)
    // The cursor's one write is the index the planner resolves fold ground
    // through; a message in the store with no seq behind it is unreachable by
    // every later fold, so the mirror is only complete with the seq. The id is
    // the store's own record id, not the log message id: the store mints one per
    // sequence, and the log seq rides beside it as `dshSeq` in the metadata.
    const mirrored = runtime!.strategy.store.getStateJson('messages') as { id: string; metadata: { dshSeq: number } }[]
    const newest = mirrored.at(-1)!
    expect(newest.metadata.dshSeq).toBe(landed.seq)
    expect(runtime!.seqOf.get(newest.id)).toBe(landed.seq)
    await expect(engine.compactNow(agent, new AbortController().signal)).resolves.not.toThrow()
  })

  it('skips a step that carries usage but no message', async () => {
    const { engine, agent, session } = build(4, 'index-usage-only')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const stored = runtime!.strategy.store.getStateJson('messages').length

    // An assistant step whose content is empty exists only to host usage. It is
    // an append surface event, so the cursor sees it — and it derives no message,
    // so recording one would put a content-less assistant turn in front of the
    // model. The event still has to be walked, or every later pass re-reads it.
    session.append('assistant/message', {
      turn: 99,
      step: 0,
      message: createAssistantMessage({ content: [], source: { provider: 'test', model: 'test-model' } }),
      usage: { inputTokens: 7, outputTokens: 0 },
    }, { surfaceOp: 'append' })
    const events = session.events.length

    await engine.compactNow(agent, new AbortController().signal)

    expect(runtime!.strategy.store.getStateJson('messages').length).toBe(stored)
    await expect(engine.compactNow(agent, new AbortController().signal)).resolves.not.toThrow()
    expect(session.events.length).toBe(events)
  })

  it('warns and keeps the session alive when a tick rejects outright', async () => {
    const { engine, agent, session } = build(4, 'index-tick-rejected')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    // A summarizer failure is quarantined inside a resolving tick; a store or
    // strategy fault rejects it. The pass is already over by then, so the only
    // thing that can keep the rejection from becoming an unhandled one is the
    // chain's own catch — and the non-Error payload is what a napi store throws.
    vi.spyOn(runtime!.strategy as unknown as { tick(): Promise<void> }, 'tick')
      .mockRejectedValue('the store is gone')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await engine.compactNow(agent, new AbortController().signal)
    await settled()

    expect(warn.mock.calls.flat().join('\n')).toContain('memory formation failed: the store is gone')
    // The chain survives the rejection, so the next pass still runs.
    await expect(engine.compactNow(agent, new AbortController().signal)).resolves.not.toThrow()
  })
})

describe('the budget a pass folds to', () => {
  it('caps the budget at the operating window when the route advertises more', async () => {
    // The harness's own window sits below every fixture's route, so this is the
    // one place the cap is the smaller of the two. Raising it above the cap is
    // what makes the cap the deciding number: a model advertising 100k tokens
    // folds to the operating point, not to whatever the route happens to allow.
    const { engine, agent, session } = build(30, 'index-capped', { operatingWindowTokens: 1_000 })
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const compile = vi.spyOn(runtime!.manager, 'compile')

    await engine.compactNow(agent, new AbortController().signal)

    // The first call of the pass is the one the budget decides; a refusal after
    // it retries at the size the strategy could actually reach.
    expect(compile.mock.calls[0]?.[0]).toEqual({
      maxTokens: 1_000 - 128,
      reserveForResponse: 128,
    })
  })
})

describe('disposal', () => {
  it('drops the runtime its session owned', async () => {
    const { engine, agent, session } = build(30, 'index-disposed')
    await engine.compactNow(agent, new AbortController().signal)
    expect(runtimes(engine).size).toBe(1)

    contextOf(engine).emit('agent/disposed', { agent, session } as never)
    await settled()
    expect(runtimes(engine).size).toBe(0)

    // Disposing a session that never opened one is a no-op rather than a throw:
    // the log-only paths reach the engine too.
    contextOf(engine).emit('agent/disposed', { agent, session } as never)
    await settled()
    expect(runtimes(engine).size).toBe(0)
  })

  it('keeps a runtime a disposal left behind when an abandoned open then fails', async () => {
    const { engine, agent, session } = build(30, 'index-disposed-mid-open')

    // Hold the session's first open open. A disposal during it drops the entry the
    // pass is waiting on, and that pass then fails from its own abandonment.
    let abandon: (error: Error) => void = () => {}
    const opening = new Promise<never>((_resolve, reject) => {
      abandon = reject
    })
    const open = vi.spyOn(ContextManager, 'open').mockReturnValueOnce(opening)

    const first = engine.compactNow(agent, new AbortController().signal).catch(() => undefined)
    for (let i = 0; i < 50 && open.mock.calls.length < 1; i += 1) await settled()
    expect(open.mock.calls.length).toBe(1)

    contextOf(engine).emit('agent/disposed', { agent, session } as never)
    await settled()

    // The session carries on without the runtime the disposal dropped, so a pass
    // in the meantime opens its own — and that is the one the abandoned open must
    // leave alone.
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    expect(runtimes(engine).size).toBe(1)
    expect(open.mock.calls.length).toBe(2)

    abandon(new Error('the open was abandoned'))
    await first
    await settled()

    // The rejection belongs to an entry that is already gone. Evicting whatever
    // the map holds now would drop a live runtime, and the next pass would rebuild
    // its store from the log and lose the work in it.
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    expect(runtimes(engine).size).toBe(1)
    expect(open.mock.calls.length).toBe(2)
  })

  it('re-seeds from the log after a disposal rather than losing the session', async () => {
    const { engine, agent, session } = build(30, 'index-reseeded')
    await engine.compactNow(agent, new AbortController().signal)
    const folded = session.surface.nodes.length

    contextOf(engine).emit('agent/disposed', { agent, session } as never)
    await settled()
    await engine.compactNow(agent, new AbortController().signal)

    // The reopened runtime replays the same log, so the surface it cooperates
    // with is the one the disposal left behind.
    expect(runtimes(engine).size).toBe(1)
    expect(session.surface.nodes.length).toBe(folded)
  })

  it('drops every runtime when the plugin unloads', async () => {
    const { engine, agent } = build(30, 'index-unloaded')
    await engine.compactNow(agent, new AbortController().signal)
    expect(runtimes(engine).size).toBe(1)

    await contextOf(engine).fiber.dispose()
    await settled()

    expect(runtimes(engine).size).toBe(0)
  })
})

describe('the pass and the calls behind it', () => {
  /** Every live memory-formation flush the log holds, as the chat row reads them. */
  function progressRecords(session: Session): { attempt: number; delta: string; done?: boolean; error?: string }[] {
    return (events(session, 'autobio/memory-progress') as { data: { attempt: number; delta: string; done?: boolean; error?: string } }[])
      .map(event => event.data)
  }

  /** The bridge call the fake summarizer was handed, once one has been made. */
  async function firstCall(calls: GenerateOptions[]): Promise<GenerateOptions> {
    for (let i = 0; i < 50 && calls.length === 0; i += 1) await settled()
    return calls[0] as GenerateOptions
  }

  it('passes on the automatic entry for a session that has logged no turn', async () => {
    const session = Session.create(SessionId('index-no-turn'))
    session.append('request/context', { provider: 'test', model: 'test-model', contextWindow: 100_000 })
    const { engine } = build(0, 'index-no-turn')

    // Nothing in the log holds a turn open, so the entry has no owner to offer a
    // bracket and leaves the surface alone rather than inventing one.
    expect(await engine.compactIfNeeded(asAgent(session, {}), 'pressure', new AbortController().signal)).toBeNull()
  })

  it('reports an automatic fold failure as an expected failure', async () => {
    const { engine, agent } = build(30, 'index-auto-broke')
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async () => {
      throw new Error('the store went away')
    })

    await expect(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal))
      .rejects.toBeInstanceOf(ManualCompactionError)
  })

  it('refuses a manual fold the agent will not claim', async () => {
    const { engine, agent } = build(30, 'index-busy-agent')
    const busy = {
      ...agent,
      // The loop refuses an idle claim while it has other work, which is a busy
      // agent rather than a fold that failed.
      runMaintenance: (): Promise<never> => { throw new Error('the agent already has active work') },
    }

    const error = await engine.compactNow(busy, new AbortController().signal)
      .then(() => { throw new Error('expected a rejection') }, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('busy')
    expect((error as ManualCompactionError).message).toContain('requires an idle agent')
  })

  it('keeps forming memory when the compile refuses', async () => {
    // Compressing is what raises the floor the next compile finds, so a session
    // riding its budget that skips its tick on a refusal never comes back under:
    // the merges its recollections are waiting for never run.
    const { engine, agent, session } = build(30, 'index-refuse-tick')
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async (asked) => {
      const budget = asked ?? { maxTokens: 0, reserveForResponse: 0 }
      throw overBudget(budget.maxTokens - 128, budget.maxTokens - 100)
    })
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    const runtime = await runtimes(engine).get(session.id)
    const tick = vi.spyOn(runtime!.strategy, 'tick')

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    await settled()

    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('cancels the calls a pass kicked when the turn that kicked them ends', async () => {
    const calls: GenerateOptions[] = []
    const { engine, agent } = build(30, 'index-turn-abort', {}, undefined, summarizer(calls))
    const turn = new AbortController()

    await engine.compactNow(agent, turn.signal)
    const call = await firstCall(calls)

    // The call starts after the pass has returned, so the pass has to leave the
    // cancellation where the bridge can read it: a turn that aborted mid-call
    // cannot keep paying for the recollection it no longer wants.
    expect(call.signal).toBeDefined()
    expect(call.signal?.aborted).toBe(false)
    turn.abort()
    expect(call.signal?.aborted).toBe(true)
  })

  it('ends the calls its maintenance claim ends', async () => {
    const calls: GenerateOptions[] = []
    const { engine, agent } = build(30, 'index-claim-abort', {}, undefined, summarizer(calls))
    const claim = new AbortController()
    const manual = {
      ...agent,
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(claim.signal),
    }

    await engine.compactNow(manual, new AbortController().signal)
    const call = await firstCall(calls)

    // The idle reservation is the other half of a manual pass: it ends when the
    // agent stops being idle, and the work it claimed has to end with it.
    expect(call.signal?.aborted).toBe(false)
    claim.abort()
    expect(call.signal?.aborted).toBe(true)
  })

  it('stamps a fold with the route its recollection voice was frozen with', async () => {
    const { engine, agent, session } = build(30, 'index-provenance', { auto: false })
    // The runtime is opened, and speaks, as the route it is handed; a request
    // routed elsewhere afterwards does not restyle the recollections already
    // being written in that voice.
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    session.append('request/context', { provider: 'other', model: 'other-model', contextWindow: 100_000 })

    const { folds } = await settle(engine, agent)

    expect(folds.length).toBeGreaterThan(0)
    const summaries = events(session, 'compaction/summary') as { data: { provider: string; model: string } }[]
    expect(summaries.every(({ data }) => data.provider === 'test' && data.model === 'test-model')).toBe(true)
    const nodes = session.events.filter(event => event.type === 'assistant/message'
      && event.data.message.source.compactionId !== undefined)
    const node = nodes.at(-1)
    expect(node?.type === 'assistant/message' ? node.data.message.source : undefined)
      .toMatchObject({ provider: 'test', model: 'test-model' })
  })

  it('accounts every call a tick settled, not only its last', async () => {
    const { engine, agent, session } = build(30, 'index-usage-per-call')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const capture = (engine as unknown as {
      captureText(s: unknown, p: unknown, delta: string, done: boolean, usage: unknown, failure: string | undefined): void
    }).captureText.bind(engine)
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    // Two ticks, each settling several calls as the refusal ladder does: the
    // record's usage is what the session's cost accounting folds in, so a tick
    // that reported only the last call would under-bill the others. The first
    // tick's calls report every optional field, the second's report none.
    const all = { cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3, costUsd: 0.5 }
    const ticks: ReadonlyArray<readonly [TokenUsage, TokenUsage]> = [
      // Every optional field reported by both calls, by only one of them, and by
      // neither: a field one call leaves out is summed from the other, and one
      // neither reports stays absent rather than becoming a zero.
      [
        { inputTokens: 10, outputTokens: 1, ...all },
        { inputTokens: 20, outputTokens: 2 },
      ],
      [
        { inputTokens: 1, outputTokens: 1 },
        { inputTokens: 2, outputTokens: 2, ...all },
      ],
      [
        { inputTokens: 3, outputTokens: 3 },
        { inputTokens: 4, outputTokens: 4 },
      ],
    ]

    for (const [index, usages] of ticks.entries()) {
      for (const usage of usages) {
        capture(session, runtime!.progress, `memory ${index}`, false, undefined, undefined)
        capture(session, runtime!.progress, '', true, usage, undefined)
      }
      // A call that reported no usage at all leaves the tick's total standing.
      capture(session, runtime!.progress, 'a call the provider did not bill', false, undefined, undefined)
      capture(session, runtime!.progress, '', true, undefined, undefined)
      settle(runtime, session)
    }

    const records = events(session, 'autobio/memory') as { data: { usage?: TokenUsage } }[]
    expect(records[0]?.data.usage).toEqual({ inputTokens: 30, outputTokens: 3, ...all })
    expect(records[1]?.data.usage).toEqual({ inputTokens: 3, outputTokens: 3, ...all })
    expect(records[2]?.data.usage).toEqual({ inputTokens: 7, outputTokens: 7 })
    await settled()
  })

  it('records a call that failed before streaming any text', async () => {
    const { engine, agent, session } = build(30, 'index-failed-call', {}, undefined, {
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('the provider hung up')
      },
    })

    await engine.compactNow(agent, new AbortController().signal)
    for (let i = 0; i < 50 && progressRecords(session).length === 0; i += 1) await settled()

    // Every request shows up in the chat, including one that failed before
    // writing a character: its terminal flush carries the failure where a
    // streamed call carries its text.
    const failed = progressRecords(session).filter(record => record.error !== undefined)
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]).toMatchObject({ delta: '', done: true, error: 'the provider hung up' })
    expect(Object.keys(failed[0] as object).sort()).toEqual(['attempt', 'delta', 'done', 'error'])
  })

  it('writes one bracket per recollection a pass planned', async () => {
    const { engine, agent, session } = build(30, 'index-multi-op')
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    const runtime = await runtimes(engine).get(session.id)
    const stored = runtime!.strategy.store.getStateJson('messages') as { id: string }[]
    // Two recollections standing over two disjoint runs of the surface, which is
    // the state a compile reaches when several chunks are ready at once.
    const runs = [stored.slice(0, 2), stored.slice(2, 4)]
    for (const [index, run] of runs.entries()) {
      const ids = run.map(message => message.id)
      runtime!.strategy.summaries.push({
        id: `L1-9${index}`,
        level: 1,
        content: `content of L1-9${index}`,
        tokens: 5,
        created: 0,
        sourceLevel: 0,
        sourceIds: ids,
        sourceRange: { first: ids[0] as string, last: ids.at(-1) as string },
      })
      for (const message of run) runtime!.strategy.resolutions.set(message.id, 1)
    }
    const landed = (): string[] => (events(session, 'compaction/summary') as { data: { compactionId: string } }[])
      .map(event => event.data.compactionId)
    const before = landed()

    const result = await engine.compactNow(agent, new AbortController().signal)

    // Both recollections were committed by the one compile, so both brackets land
    // in the one pass: a pass that folds only the first leaves the rest of the
    // layout it just committed standing unfolded until the next step boundary.
    expect(landed().slice(before.length)).toEqual(expect.arrayContaining(['autobio:L1-90', 'autobio:L1-91']))
    expect(result).not.toBeNull()
    await settled()
  })

  it('reports a planner divergence as a changed span rather than an unexpected error', async () => {
    const { engine, agent, session } = build(30, 'index-divergence')
    await engine.compactNow(agent, new AbortController().signal)
    await settled()
    const runtime = await runtimes(engine).get(session.id)
    const stored = runtime!.strategy.store.getStateJson('messages') as { id: string }[]
    // A pinned message keeps the frontier it was resolved under, so a pin can
    // outlive the recollection behind it: the store then resolves ground no
    // recollection stands over, which is the planner's own divergence. It has to
    // reach `/compact` as a failed span rather than as an unexpected crash the
    // command adapter rethrows.
    runtime!.strategy.locked.add(stored.at(-1)!.id)
    runtime!.strategy.resolutions.set(stored.at(-1)!.id, 7)

    const error = await engine.compactNow(agent, new AbortController().signal)
      .then(() => { throw new Error('expected a rejection') }, (caught: unknown) => caught)

    expect(error).toBeInstanceOf(ManualCompactionError)
    expect((error as ManualCompactionError).code).toBe('changed')
    expect((error as ManualCompactionError).message).toContain('no level-7 recollection stands for log seq')
  })

  it('owns an automatic fold by the turn the log holds open', async () => {
    const { engine, agent, session } = build(30, 'index-open-turn')
    // The automatic entry has no step to be handed, so the turn it folds inside
    // is the one the log holds open and nothing else.
    session.append('turn/start', { turn: 30 })

    const { folds } = await settle(engine, agent)

    expect(folds.length).toBeGreaterThan(0)
    const owners = (events(session, 'compaction/start') as { data: { turn: number | null } }[])
      .map(event => event.data.turn)
    expect(new Set(owners)).toEqual(new Set([30]))
  })

  /** Every bracket owner in the log, in the order the brackets landed. */
  function owners(session: Session): (number | null)[] {
    return (events(session, 'compaction/start') as { data: { turn: number | null } }[])
      .map(event => event.data.turn)
  }

  it('owns an automatic fold by no turn at all when the log holds none open', async () => {
    const { engine, agent, session } = build(30, 'index-auto-standalone')
    // Every turn the fixture started has ended, so nothing holds a turn open and
    // `null` is the standalone shape the invariant accepts. A bracket left holding
    // the newest closed turn is one no turn boundary can ever close.
    const { folds } = await settle(engine, agent)

    expect(folds.length).toBeGreaterThan(0)
    expect(owners(session)).toEqual(owners(session).map(() => null))
  })

  it('owns a manual fold by no turn at all when the log holds none open', async () => {
    const { engine, agent, session } = build(30, 'index-manual-standalone')
    // The idle agent `/compact` folds on, whose log holds no turn open either.
    const { folds } = await settle(engine, agent, (_context, signal) => engine.compactNow(agent, signal))

    expect(folds.length).toBeGreaterThan(0)
    expect(owners(session)).toEqual(owners(session).map(() => null))
  })
})
