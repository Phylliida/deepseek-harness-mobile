import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AutobiographicalCompactionEngine from '@deepseek-ai/dsh-compaction-autobiographical'
import type { AutobiographicalCompactionConfig } from '@deepseek-ai/dsh-compaction-autobiographical'
import type { CompactionAgentContext, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRuntime } from '../src/mirror.ts'

const SIGNAL = new AbortController().signal
const ROUTE = { provider: 'test', model: 'test-model' }
const ENTER: PreStepDecision = { kind: 'enter', messages: [] }

/** Adapter answering every memory-formation call with a fixed recollection. */
class MemoryAdapter extends LlmAdapter {
  calls = 0

  constructor(private readonly endsInError = false) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.endsInError) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'compression unavailable', code: 'E_COMPRESSION' } },
      }
      return
    }
    const text = 'I recall the earlier exchange about lorem ipsum.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One open archive plus its serialized compression chain. */
interface EngineEntry {
  runtime: SessionRuntime
  tickChain: Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Drive fold passes (each preceded by a tick interval) until one lands. */
async function foldUntilLanded(
  engine: AutobiographicalCompactionEngine,
  agent: Agent,
  passes = 40,
): Promise<unknown> {
  let result: unknown = null
  for (let pass = 0; pass < passes && result === null; pass++) {
    await sleep(20)
    result = await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
  }
  return result
}

/** Drive the step waterfall until a fold lands, or the pass budget runs out. */
async function foldAtStepBoundaries(
  ctx: Context,
  agent: Agent,
  session: Session,
  passes = 40,
): Promise<boolean> {
  for (let pass = 0; pass < passes; pass++) {
    await sleep(20)
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve(ENTER),
    )
    // The listener never reshapes the step: it folds, then defers to `next`.
    expect(decision).toEqual(ENTER)
    if (session.events.some(event => event.type === 'compaction/summary')) return true
  }
  return false
}

/** Turns the engine's private runtime cache into a test seam. */
function internals(engine: AutobiographicalCompactionEngine): { runtimes: Map<SessionId, Promise<EngineEntry>> } {
  return engine as unknown as { runtimes: Map<SessionId, Promise<EngineEntry>> }
}

function openEntry(engine: AutobiographicalCompactionEngine, session: Session): Promise<EngineEntry> {
  const opening = internals(engine).runtimes.get(session.id)
  if (opening === undefined) throw new Error('the engine never opened this session archive')
  return opening
}

/** Replace collaborators on an open archive's ContextManager. */
function patchManager(entry: EngineEntry, patch: Record<string, unknown>): void {
  Object.assign(entry.runtime.manager as unknown as Record<string, unknown>, patch)
}

interface ConversationOptions {
  /** Append `turn/start`/`turn/end` markers around every exchange. */
  readonly markers?: boolean
  /** Stamp a routed request target as the log's first event. */
  readonly routedContext?: boolean
  /** Absolute working directory to stamp into the session header. */
  readonly cwd?: string
}

/** A session of `turns` exchanges, shaped like one a live loop appended. */
function conversation(turns: number, options: ConversationOptions = {}): Session {
  const { markers = true, routedContext = false, cwd } = options
  const id = SessionId(`autobio-engine-${turns}-${markers ? 'marked' : 'bare'}`)
  const session = cwd === undefined
    ? Session.create(id)
    : Session.create(id, undefined, {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      cwd,
    })
  if (routedContext) {
    session.append('request/context', { provider: ROUTE.provider, model: ROUTE.model, contextWindow: 600 })
  }
  const filler = 'lorem ipsum dolor sit amet '.repeat(8)
  for (let turn = 1; turn <= turns; turn++) {
    if (markers) session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${filler} question ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${filler} answer ${turn}` }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    if (markers) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

describe('AutobiographicalCompactionEngine wiring', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(
    overrides: AutobiographicalCompactionConfig = {},
    options: { endsInError?: boolean; storeRoot?: string; omitContextWindow?: boolean } = {},
  ) {
    const root = options.storeRoot ?? mkdtempSync(join(tmpdir(), 'autobio-engine-'))
    roots.push(root)
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    const adapter = new MemoryAdapter(options.endsInError ?? false)
    ctx.llm.registerAdapter(['test'], adapter)
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const config: AutobiographicalCompactionConfig = {
      storeRoot: root,
      contextWindowTokens: 400,
      reserveTokens: 100,
      recentWindowTokens: 120,
      headWindowTokens: 0,
      targetChunkTokens: 60,
      mergeThreshold: 2,
      maxTokens: 8192,
      auto: false,
      ...overrides,
    }
    // Simulate a deployment that configured no window of its own.
    if (options.omitContextWindow === true) delete config.contextWindowTokens
    const engine = new AutobiographicalCompactionEngine(ctx, config)
    void llm
    return { ctx, engine, adapter, warnings, root }
  }

  it('folds at every step boundary through the automatic listener', async () => {
    const { ctx, adapter } = setup({ auto: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent

    let folded = false
    for (let pass = 0; pass < 40 && !folded; pass++) {
      await sleep(20)
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve(ENTER),
      )
      // The listener never reshapes the step: it folds, then defers to `next`.
      expect(decision).toEqual(ENTER)
      folded = session.events.some(event => event.type === 'compaction/summary')
    }

    expect(folded).toBe(true)
    expect(adapter.calls).toBeGreaterThan(0)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(true)
    expect(session.events.some(event => event.type === 'compaction/end')).toBe(true)
  }, 30_000)

  it('skips the automatic pass when the step signal is already aborted', async () => {
    const { ctx, engine } = setup({ auto: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    const controller = new AbortController()
    controller.abort()

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve(ENTER),
    )
    expect(decision).toEqual(ENTER)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(internals(engine).runtimes.size).toBe(0)
  })

  it('warns and continues the turn when folding cannot find a route', async () => {
    const { ctx, warnings } = setup({
      auto: true,
    })
    const session = conversation(12)
    const agent = { session, options: {} } as Agent

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve(ENTER),
    )).resolves.toEqual(ENTER)

    expect(warnings.some(message => /^autobiographical folding failed: .*no summarization route/.test(message)))
      .toBe(true)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('warns and continues the turn when a pass is cancelled mid-flight', async () => {
    const { ctx, engine, warnings } = setup({ auto: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)

    // Hold the pass inside its first awaited frontier call, so the abort lands
    // with the pass suspended — the cancellation the listener must survive.
    let release: (() => void) | undefined
    patchManager(await openEntry(engine, session), {
      compile: () => new Promise<void>((resolve) => { release = resolve }),
      previewContext: () => ({ entries: [] }),
    })
    const controller = new AbortController()
    const pending = agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: controller.signal },
      () => Promise.resolve(ENTER),
    )
    await expect.poll(() => release !== undefined).toBe(true)
    controller.abort()
    release!()

    await expect(pending).resolves.toEqual(ENTER)
    expect(warnings.some(message => message.startsWith('autobiographical folding failed: '))).toBe(true)
  }, 30_000)

  it('reports a missing summarization route instead of folding', async () => {
    const { engine } = setup()
    const session = conversation(12)

    // No configured pair, no routed request, and no usable agent options: a
    // provider without a model, a model without a provider, then neither.
    await expect(engine.compactIfNeeded({ session, options: { provider: '', model: 'test-model' } }, 'pressure', SIGNAL))
      .rejects.toThrow(/no summarization route/)
    await expect(engine.compactIfNeeded({ session, options: { provider: 'test' } }, 'pressure', SIGNAL))
      .rejects.toThrow(/no summarization route/)
    await expect(engine.compactIfNeeded({ session, options: {} }, 'pressure', SIGNAL))
      .rejects.toThrow(/no summarization route/)
    // A rejected resolution is never cached, so every retry re-resolves.
    expect(internals(engine).runtimes.size).toBe(0)
  })

  /** Block the per-session archive path with a regular file: the open fails. */
  function blockArchive(root: string, session: Session): void {
    const path = join(root, session.id)
    mkdirSync(root, { recursive: true })
    writeFileSync(path, 'not an archive')
  }

  it('drops a failed archive open so the next pass retries', async () => {
    const { engine, root } = setup()
    const session = conversation(12)
    blockArchive(root, session)
    const agent = { session, options: ROUTE } as Agent

    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).rejects.toThrow()
    expect(internals(engine).runtimes.size).toBe(0)
  })

  it('drops a failed open when the agent is disposed before it settles', async () => {
    const { ctx, engine, root } = setup()
    const session = conversation(12)
    blockArchive(root, session)
    const agent = { session, options: ROUTE } as Agent

    const pending = engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(internals(engine).runtimes.size).toBe(1)
    // Disposal races the failing open: the entry is dropped, and the failed
    // close chain must not surface as an unhandled rejection.
    ctx.emit('agent/disposed', { agent })
    expect(internals(engine).runtimes.size).toBe(0)
    await expect(pending).rejects.toThrow()
  })

  it('ignores disposal for a session with no open archive', () => {
    const { ctx, engine } = setup()
    const session = conversation(2)
    expect(() => {
      ctx.emit('agent/disposed', { agent: { session, options: {} } as Agent })
    }).not.toThrow()
    expect(internals(engine).runtimes.size).toBe(0)
  })

  it('resolves the route and the compile budget from the session request context', async () => {
    const { engine, adapter } = setup(
      {},
      { omitContextWindow: true },
    )
    // The agent loop stamps the routed target before the first step; the
    // backend reuses it for both the memory-formation voice and the budget.
    const session = conversation(12, { routedContext: true })
    const agent = { session, options: {} } as Agent

    await expect(foldUntilLanded(engine, agent)).resolves.not.toBeNull()
    expect(adapter.calls).toBeGreaterThan(0)
    const summary = session.events.find(event => event.type === 'compaction/summary')
    expect(summary?.data).toMatchObject({ provider: ROUTE.provider, model: ROUTE.model })
  }, 30_000)

  it('resolves the route from the agent options and stamps the fold with the routed pair', async () => {
    const { engine, adapter } = setup()
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent

    await expect(foldUntilLanded(engine, agent)).resolves.not.toBeNull()
    expect(adapter.calls).toBeGreaterThan(0)
    // The pass runs on the agent's route; the landed fold records the backend's
    // own configured pair, which is empty here.
    const summary = session.events.find(event => event.type === 'compaction/summary')
    expect(summary?.data).toMatchObject({ provider: '', model: '' })
  }, 30_000)

  it('skips the pass until a compile budget is known', async () => {
    const { engine } = setup({}, { omitContextWindow: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent

    // Nothing has routed a request yet, so no window is known.
    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('skips the pass when the frontier cannot fit the compile budget', async () => {
    const { engine, warnings } = setup({ contextWindowTokens: 40, reserveTokens: 39 })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent

    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
    expect(warnings.some(message => message.startsWith(
      'autobiographical frontier planning found no layout that fits: ',
    ))).toBe(true)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('skips the pass when the strategy previews no layout', async () => {
    const { engine } = setup()
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    // A committed compile with no previewable layout: the pass has nothing to land.
    patchManager(await openEntry(engine, session), {
      compile: () => Promise.resolve(),
      previewContext: () => null,
    })

    const foldsBefore = session.events.filter(event => event.type === 'compaction/start').length
    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
    expect(session.events.filter(event => event.type === 'compaction/start')).toHaveLength(foldsBefore)
  })

  it.each([true, false])(
    'warns when the preview reports a layout that cannot fit (exhausted=%s)',
    async (exhausted) => {
      const { engine, warnings } = setup()
      const session = conversation(12)
      const agent = { session, options: ROUTE } as Agent
      await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
      // An infeasible preview answers with diagnostics instead of rendered
      // entries: the state a session reaches when its foldable middle outgrows
      // the budget faster than memory formation compresses it.
      patchManager(await openEntry(engine, session), {
        compile: () => Promise.resolve(),
        previewContext: () => ({
          finalTokens: 90,
          budgetTokens: 40,
          fits: false,
          exhausted,
          headTokens: 0,
          tailTokens: 30,
          middleTokens: 60,
          middleChunkCount: 3,
          deepestLevel: 2,
          resolutions: {},
          moves: 0,
          producedCount: 0,
        }),
      })

      const foldsBefore = session.events.filter(event => event.type === 'compaction/start').length
      await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
      expect(warnings).toContain(
        'autobiographical frontier planning found no layout that fits: 90 tokens against a 40-token budget '
        + '(head 0, tail 30, middle 60 across 3 chunks, deepest level 2'
        + `${exhausted ? ', picker exhausted' : ''}); `
        + 'leaving the surface unchanged for this pass',
      )
      expect(session.events.filter(event => event.type === 'compaction/start')).toHaveLength(foldsBefore)
    },
  )

  it('warns when frontier planning fails with a non-Error', async () => {
    const { engine, warnings } = setup()
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    patchManager(await openEntry(engine, session), {
      compile: async () => { throw 'planning transport closed' },
    })

    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
    expect(warnings).toContain(
      'autobiographical frontier planning found no layout that fits: planning transport closed; '
      + 'leaving the surface unchanged for this pass',
    )
  })

  it.each([
    ['store transport closed', 'store transport closed'],
    [new Error('store transport closed'), 'store transport closed'],
  ])('warns when background memory formation fails with %j', async (thrown, text) => {
    const { engine, warnings } = setup()
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    const entry = await openEntry(engine, session)
    patchManager(entry, {
      tick: async () => { throw thrown },
    })

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    await entry.tickChain
    expect(warnings).toContain(`autobiographical memory formation failed: ${text}`)
  })

  it('warns and continues the turn when a store failure is not an Error', async () => {
    const { ctx, engine, warnings } = setup({ auto: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    patchManager(await openEntry(engine, session), {
      addMessage: () => { throw 'store transport closed' },
    })
    // History past the watermark is what drives the mirror into the store.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'a question after the store failed' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 2, step: 1, signal: SIGNAL },
      () => Promise.resolve(ENTER),
    )).resolves.toEqual(ENTER)
    expect(warnings).toContain('autobiographical folding failed: store transport closed; continuing the turn')
  })

  it('warns through the harness logger when a memory-formation call fails', async () => {
    const { engine, adapter, warnings } = setup({}, { endsInError: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await foldUntilLanded(engine, agent, 10)
      expect(adapter.calls).toBeGreaterThan(0)
      // The bridge owns the diagnostic; the engine routes it to both the
      // harness logger and the console the library narrates its quarantines to.
      await expect.poll(() => warnings.some(message => message.startsWith('compression call ended error: ')))
        .toBe(true)
      expect(consoleWarn.mock.calls
        .some(([message]) => String(message).startsWith('[compaction-autobiographical] compression call ended error: ')))
        .toBe(true)
    } finally {
      consoleWarn.mockRestore()
    }
  }, 30_000)

  it('runs a manual compaction as agent maintenance and attributes it to no turn', async () => {
    const { engine, adapter } = setup()
    // History without turn markers: the fold has no live turn to attribute to.
    const session = conversation(12, { markers: false, routedContext: true })
    const agent = {
      session,
      options: ROUTE,
      runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(SIGNAL),
    } as unknown as ManualCompactAgentContext

    let result: unknown = null
    for (let pass = 0; pass < 40 && result === null; pass++) {
      await sleep(20)
      result = await engine.compactNow(agent, SIGNAL)
    }

    expect(result).not.toBeNull()
    expect(adapter.calls).toBeGreaterThan(0)
    // A standalone attempt brackets with a null turn, and its fold node — which
    // needs a turn number — falls back to the session's first turn.
    const start = session.events.find(event => event.type === 'compaction/start')
    expect(start?.data.turn).toBeNull()
    const foldNode = session.events.find(event => event.type === 'assistant/message'
      && event.surfaceOp !== 'append')
    expect(foldNode?.type === 'assistant/message' ? foldNode.data.turn : undefined).toBe(0)
  }, 30_000)

  it('propagates a maintenance failure from a manual compaction', async () => {
    const { engine } = setup()
    const session = conversation(12)
    const agent = {
      session,
      options: ROUTE,
      runMaintenance: () => Promise.reject(new Error('another maintenance task is running')),
    } as unknown as ManualCompactAgentContext

    await expect(engine.compactNow(agent, SIGNAL)).rejects.toThrow('another maintenance task is running')
  })

  it('resolves the archive under the session working directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'autobio-cwd-'))
    roots.push(cwd)
    const { engine, root } = setup({ storeRoot: '.dsh/autobio' })
    const session = conversation(12, { cwd })
    const agent = { session, options: ROUTE } as Agent

    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    expect(existsSync(join(cwd, '.dsh', 'autobio', session.id))).toBe(true)
    // ...and not under the process-relative root an absent cwd resolves against.
    expect(existsSync(join(root, session.id))).toBe(false)
  })

  it('leaves a session with nothing worth folding untouched', async () => {
    const { engine, adapter } = setup()
    // No turn marker anywhere: the pass has no turn to attribute a fold to,
    // and a two-exchange history holds nothing worth folding.
    const session = conversation(2, { markers: false, routedContext: true })
    const agent: CompactionAgentContext = { session, options: ROUTE }

    await expect(engine.compactIfNeeded(agent, 'pressure', SIGNAL)).resolves.toBeNull()
    expect(adapter.calls).toBe(0)
    // A tick with no work forms no memory and logs no event.
    expect(session.events.some(event => event.type === 'autobio/memory')).toBe(false)
  })

  it('aborts a waiting catch-up without landing anything', async () => {
    const { engine } = setup({ contextWindowTokens: 40, reserveTokens: 39 })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    const aborted = AbortSignal.abort()
    await expect(engine.compactIfNeeded(agent, 'pressure', aborted)).resolves.toBeNull()
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('logs a stats-only memory event when a tick changes stats without minting', async () => {
    const { engine } = setup({ contextWindowTokens: 40, reserveTokens: 39 })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    const entry = await openEntry(engine, session)
    // A tick whose stats move without a new recollection: the event carries
    // no `memory`, and the chat row stays non-expandable. The flip happens
    // exactly once so the next tick observes no change and the pass ends.
    const strategy = entry.runtime.strategy as unknown as { getStats: () => { pendingMerges: number } & Record<string, number> }
    const real = strategy.getStats.bind(entry.runtime.strategy)
    let flipped = false
    strategy.getStats = () => ({ ...real(), pendingMerges: real().pendingMerges + (flipped ? 1 : 0) })
    patchManager(entry, { tick: () => { flipped = true; return Promise.resolve() } })

    const eventsBefore = session.events.filter(candidate => candidate.type === 'autobio/memory').length
    await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    const added = session.events.filter(candidate => candidate.type === 'autobio/memory').slice(eventsBefore)
    expect(added).toHaveLength(1)
    expect(added[0]?.data.memory).toBeUndefined()
  })

})

describe('automatic folding runtime toggle', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(overrides: AutobiographicalCompactionConfig = {}) {
    const root = mkdtempSync(join(tmpdir(), 'autobio-toggle-'))
    roots.push(root)
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    const adapter = new MemoryAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const engine = new AutobiographicalCompactionEngine(ctx, {
      storeRoot: root,
      contextWindowTokens: 400,
      reserveTokens: 100,
      recentWindowTokens: 120,
      headWindowTokens: 0,
      targetChunkTokens: 60,
      mergeThreshold: 2,
      ...overrides,
    })
    void llm
    return { ctx, engine, adapter }
  }

  it('starts a disabled engine folding when it is turned on', async () => {
    const { ctx, engine, adapter } = setup({ auto: false })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    expect(engine.isAutomaticFoldingEnabled).toBe(false)

    expect(engine.setAutomaticFolding(true)).toBe(true)
    expect(engine.isAutomaticFoldingEnabled).toBe(true)

    await expect(foldAtStepBoundaries(ctx, agent, session)).resolves.toBe(true)
    expect(adapter.calls).toBeGreaterThan(0)
  }, 30_000)

  it('stops the automatic pass when folding is turned off, while explicit passes still fold', async () => {
    const { ctx, engine, adapter } = setup({ auto: true })
    const session = conversation(12)
    const agent = { session, options: ROUTE } as Agent
    expect(engine.setAutomaticFolding(false)).toBe(false)
    expect(engine.isAutomaticFoldingEnabled).toBe(false)

    // The listener is gone, so the pass does not even open the archive.
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve(ENTER),
    )
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(internals(engine).runtimes.size).toBe(0)

    // Disabling stops the engine's own schedule, not its ability to fold.
    await expect(foldUntilLanded(engine, agent)).resolves.not.toBeNull()
    expect(adapter.calls).toBeGreaterThan(0)
  }, 30_000)

  it('registers one listener per enable and clears it on disable', async () => {
    const { ctx, engine } = setup({ auto: true })
    const onSpy = vi.spyOn(ctx, 'on')
    const preStepRegistrations = (): number =>
      onSpy.mock.calls.filter(([name]) => name === 'agent/pre-step').length

    // Already on, then off, then on again: each call reports the state it left.
    expect(engine.setAutomaticFolding(true)).toBe(true)
    expect(preStepRegistrations()).toBe(0)
    expect(engine.setAutomaticFolding(false)).toBe(false)
    expect(preStepRegistrations()).toBe(0)
    expect(engine.setAutomaticFolding(true)).toBe(true)
    expect(preStepRegistrations()).toBe(1)
    expect(engine.setAutomaticFolding(false)).toBe(false)
    expect(engine.setAutomaticFolding(false)).toBe(false)
    expect(engine.setAutomaticFolding(true)).toBe(true)
    expect(preStepRegistrations()).toBe(2)
  })
})
