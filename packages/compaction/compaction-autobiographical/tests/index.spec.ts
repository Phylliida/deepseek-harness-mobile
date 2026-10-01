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
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutobiographicalCompactionEngine } from '../src/index.ts'
import type { ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { build, contextOf } from './harness.ts'

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
  } as unknown as ManualCompactAgentContext
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
