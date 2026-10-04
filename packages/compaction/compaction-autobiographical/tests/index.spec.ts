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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutobiographicalCompactionEngine from '../src/index.ts'
import { describeJsonFailures } from '../src/index.ts'
import type { ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { build, contextOf, summarizer } from './harness.ts'

/** Let the fire-and-forget tick chain finish. It is never awaited by a pass. */
async function settled(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** An open runtime: the strategy it holds and the manager a pass compiles through. */
interface OpenRuntime {
  strategy: { summaries: unknown[]; tick(): Promise<void>; store: { getStateJson(id: string): unknown[] } }
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

  it('does not retry a refusal it can already afford', async () => {
    const { engine, agent } = build(30, 'index-refuse-affordable')
    const compile = vi.spyOn(ContextManager.prototype, 'compile')
      .mockImplementation(async (_budget) => {
        throw overBudget(_budget?.maxTokens ?? 0, 100)
      })

    expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull()
    // 100 + 128 fits inside 572, so a retry would ask for less than the budget
    // that already refused. Nothing is gained by trying again.
    expect(compile).toHaveBeenCalledTimes(1)
  })

  it('surfaces a compile failure that is not a refusal', async () => {
    const { engine, agent } = build(30, 'index-compile-broke')
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async () => {
      throw new Error('the store went away')
    })

    await expect(engine.compactNow(agent, new AbortController().signal)).rejects.toThrow('the store went away')
  })

  it('warns and folds again next step when the retry is still over budget', async () => {
    const { engine, agent } = build(30, 'index-over-budget')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(ContextManager.prototype, 'compile').mockImplementation(async (_budget) => {
      const budget = _budget ?? { maxTokens: 0, reserveForResponse: 0 }
      // Over budget yet again, but only just: the next pass will not be.
      throw overBudget(budget.maxTokens, budget.maxTokens + 10)
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
  it('reports what a refused record holds, including the values JSON would hide', () => {
    // The readings the log's own refusal cannot show: `JSON.stringify` renders an
    // absent value and a non-finite number as `null`, and an exotic object as an
    // empty one, so the report names each by what it actually is and where it sits.
    expect(describeJsonFailures({
      attempt: 3,
      usage: { inputTokens: 1, cacheReadTokens: undefined },
      memory: { id: 'L1-4', tokens: Number.NaN, created: new Date(0), sourceRange: { firstSeq: 1, lastSeq: 2 } },
    })).toEqual([
      'usage.cacheReadTokens is undefined',
      'memory.tokens is a non-finite number (NaN)',
      'memory.created is a Date',
    ])
  })

  it('reports a record whose values are all storable as such', () => {
    expect(describeJsonFailures({ attempt: 3, statistics: { l1: 0, l2: 1 }, text: 'x'.repeat(301) }))
      .toEqual(['none — every value in the record is storable JSON'])
  })

  it('reports a value by kind where its own text would say nothing', () => {
    // A function is refused for what it is: its own text is not the value's text.
    // An exotic object is refused by its constructor, because the log finds no
    // fields in it to walk into.
    expect(describeJsonFailures({ usage: { run: function named() { return 1 } } }))
      .toEqual(['usage.run is a function (named)'])
    expect(describeJsonFailures({ usage: (name: string) => name })).toEqual(['usage is a function (usage)'])
    expect(describeJsonFailures({ usage: new Map([['a', 1]]) })).toEqual(['usage is a Map'])
  })

  it('reports a bare value the log refuses rather than one of a record\'s fields', () => {
    expect(describeJsonFailures(Number.NaN)).toEqual(['<the record itself> is a non-finite number (NaN)'])
  })

  it('reports a field by its path through a list as well as a record', () => {
    expect(describeJsonFailures({ memory: { sourceIds: ['a', undefined] } }))
      .toEqual(['memory.sourceIds.1 is undefined'])
  })

  it('binds the text it reports to a line rather than dumping a recollection', () => {
    // A recollection's own content is the one value here that runs long, so the
    // two cuts — the string's, and the record's — are what keeps the line readable.
    expect(describeJsonFailures({ memory: { content: 'y'.repeat(400) } }))
      .toEqual(['none — every value in the record is storable JSON'])
    expect(describeJsonFailures({ memory: { content: 'y'.repeat(400), tokens: Number.POSITIVE_INFINITY } }))
      .toEqual(['memory.tokens is a non-finite number (Infinity)'])
    expect(describeJsonFailures({ memory: { tokens: 'z'.repeat(400) } }))
      .toEqual(['none — every value in the record is storable JSON'])
  })

  it('reports the text of a plain object the log cannot store', () => {
    expect(describeJsonFailures({ memory: { sourceRange: { firstSeq: 1, lastSeq: 2, at: undefined } } }))
      .toEqual(['memory.sourceRange.at is undefined'])
  })

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

  it('reports the value the log refuses instead of writing a record without it', async () => {
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
      content: 'a memory priced at no number at all',
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

    // The console carries what the log could not take and where it sat in the
    // record — `JSON.stringify` would have rendered that `NaN` as `null` — and
    // the log is left without a record rather than with a wrong one.
    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('memory.tokens') && line.includes('NaN'))).toBe(true)
    expect(events(session, 'autobio/memory')).toHaveLength(written)

    // The counter moved with the attempt, so the next pass has nothing to add:
    // a record that keeps being refused must not append a warning per pass.
    warn.mockClear()
    settle(runtime, session)
    expect(warn).not.toHaveBeenCalled()
  })

  it('names the nested path of a value the log refuses', async () => {
    const { engine, agent, session } = build(30, 'index-unstorable-nested')
    await engine.compactNow(agent, new AbortController().signal)
    const runtime = await runtimes(engine).get(session.id)
    const written = events(session, 'autobio/memory').length
    // Every field of the recollection is storable; the span it stands over is
    // not, and the record has to say so by the path to it.
    runtime?.strategy.summaries.push({
      id: 'L1-7',
      level: 1,
      content: 'a memory standing over a span with no bound',
      tokens: 12,
      created: 0,
      sourceIds: ['ground-1'],
    })
    runtime!.seqOf.set('ground-1', Number.POSITIVE_INFINITY)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const settle = (engine as unknown as {
      appendMemory(r: unknown, s: unknown): void
    }).appendMemory.bind(engine)

    settle(runtime, session)

    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('memory.sourceRange.firstSeq') && line.includes('Infinity'))).toBe(true)
    expect(events(session, 'autobio/memory')).toHaveLength(written)
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

    // Every value in the record is one the log stores, so the report says that
    // rather than naming an offender that does not exist — a refusal with no
    // offending value is a different bug, and the report must not blur the two.
    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('the log closed mid-write'))).toBe(true)
    expect(lines.some(line => line.includes('every value in the record is storable JSON'))).toBe(true)
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
