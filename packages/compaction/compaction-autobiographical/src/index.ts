/**
 * Autobiographical compaction: aged history folds into recollections that live
 * in the session log and nowhere else.
 *
 * The context-manager library keeps all its state in a store; this backend hands
 * it an in-memory one ({@link LogStore}) seeded from the session's surface at
 * open. So the log is the only durable copy — a restart costs a replay and zero
 * inference calls, and a fork inherits its lineage by construction rather than by
 * copying a directory. Folds are the log's only writes, and a fold node's id is
 * the handle the strategy needs to find its own work again on the next open.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical
 */

import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '@animalabs/context-manager'
import type { SummaryEntry, TokenBudget } from '@animalabs/context-manager'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RequestContext, Session } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { applyFold } from './apply.ts'
import { createBridge } from './bridge.ts'
import { resolveConfig } from './config.ts'
import { planFolds } from './plan.ts'
import { appendSurfaceNode, resolveRange, seedFromLog } from './seed.ts'
import { createStore } from './store.ts'
import type { LogStore } from './store.ts'
import type { AutobiographicalCompactionConfig, AutobiographicalMemoryMint, RecollectionRange } from './types.ts'

export type {
  AutobiographicalCompactionConfig,
  AutobiographicalMemoryEventData,
  AutobiographicalMemoryMint,
} from './types.ts'

/** Plugin name, for the config catalog and console diagnostics. */
export const name = 'compaction-autobiographical'

/** Services this engine needs before it can fold anything. */
export const inject = ['llm', 'compaction']

/**
 * Ceiling for the context the strategy keeps live, reached by folding aged
 * history. Models degrade well before their advertised window, so the operating
 * point sits here whatever the route advertises.
 */
const OPERATING_WINDOW_CAP = 65_536

/** The live context-manager stack for one session. */
interface Runtime {
  manager: ContextManager
  store: LogStore
  strategy: AutobiographicalStrategy
  /** Log seq coverage per seeded recollection. */
  known: Map<string, RecollectionRange>
  /** Log seq behind each mirrored message id. */
  seqOf: Map<string, number>
  /**
   * Highest log seq mirrored into the store. Replay leaves it at the log's end,
   * so a live pass only ever walks what arrived since.
   */
  cursor: number
  /** Recollections already announced in the log. */
  announced: Set<string>
  /**
   * The attempt counter a replayed log reconstructs, this call's usage, and
   * whether the call streamed any text — the terminal flush carries an empty
   * delta, so only the mid-call flushes prove a call produced something.
   */
  progress: { attempt: number; active: boolean; usage?: TokenUsage }
  /** Newest event seq fed to calibration, so one usage is reported once. */
  lastFedSeq: number
  /** Background work chain; a turn never awaits it. */
  tickChain: Promise<void>
}

/**
 * Fold aged history into recollections, one fold node per recollection, written
 * to the session log as it lands.
 */
export class AutobiographicalCompactionEngine extends CompactionEngine {
  static readonly inject = inject

  /**
   * Configuration for the log-native autobiographical backend.
   */
  static readonly Config = Schema.object({
    /**
     * Ceiling for the live context the strategy keeps, reached by folding aged
     * history. Defaults to the routed model's window, capped at 65_536.
     */
    operatingWindowTokens: Schema.number(),
    /**
     * Tokens reserved for the model's response inside the compile budget, and
     * the breathing room kept below the operating window. Default 8192.
     */
    reserveTokens: Schema.number().default(8192),
    /** Register the step-boundary folding listener. Default true. */
    auto: Schema.boolean().default(true),
    /**
     * Strategy knobs handed to `AutobiographicalStrategy` untouched, so upstream
     * options (`kvStableReachTokens`, `speculativeProduction`, `summaryTargetTokens`, …)
     * flow with the library version instead of being mirrored here field by field.
     * The integration's own requirements override any overlap.
     */
    strategy: Schema.dict(Schema.any()).default({}),
  })

  private readonly config: ReturnType<typeof resolveConfig>
  private readonly runtimes = new Map<string, Promise<Runtime>>()

  /**
   * Register the engine and, unless `auto` is false, the step-boundary listener
   * that folds history before each request is derived.
   * @param ctx - plugin context carrying the LLM and compaction services.
   * @param config - harness knobs plus the strategy passthrough bag.
   */
  constructor(ctx: Context, config: AutobiographicalCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this.registerAutomaticFolding()
    // Dropping the runtime is the whole of disposal. `ContextManager.close()`
    // calls the store's `close` only when the manager opened it itself, and this
    // backend always hands its own store in, so there is nothing to close — and
    // the map entry is the only thing holding the seeded store alive.
    ctx.on('agent/disposed', ({ agent }) => {
      this.runtimes.delete(agent.session.id)
    })
    ctx.effect(() => () => { this.runtimes.clear() }, 'compaction-autobiographical.disposal')
  }

  /** How many sessions hold a seeded runtime. Disposal is the whole of what it changes. */
  get openRuntimes(): number {
    return this.runtimes.size
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return this.foldPass(agent)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    _signal: AbortSignal,
    _sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    return agent.runMaintenance(() => this.foldPass(agent))
  }

  /**
   * Explicit ranges are rejected: recollections are chosen by the strategy's own
   * picker from what has aged, never from a caller-supplied span.
   */
  override compactRegion(
    _start: number,
    _end: number,
    _agent: CompactionAgentContext,
    _signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return Promise.reject(new ManualCompactionError(
      'summary',
      'compaction-autobiographical folds history as it ages and does not take an explicit range',
    ))
  }

  /**
   * Fold aged history before the next request is derived. A failure is loud on
   * the console and never stops the turn: the strategy replans from the log on
   * every compile, so the next step boundary is a complete retry.
   */
  private registerAutomaticFolding(): void {
    this.ctx.on('agent/pre-step', async (
      { agent },
      next,
    ) => {
      try {
        await this.foldPass(agent)
      } catch (error: unknown) {
        this.warn(`folding failed: ${describe(error)}; continuing the turn`)
      }
      return next()
    })
  }

  /**
   * One folding pass: replay what the log gained, kick memory formation off the
   * turn's critical path, report the last step's real prompt size, then compile
   * and write down the layout the strategy reached.
   *
   * Compiling is what commits the picker's resolutions, so it runs before
   * planning rather than only at request time. Nothing here waits on a model:
   * `compile` reads the store, and folding already happened in the form of
   * recollections the last ticks minted.
   */
  private async foldPass(agent: CompactionAgentContext): Promise<CompactionResult | null> {
    // Both refusals are the session's to fix, not the pass's to fail: a session
    // that has not routed has no budget and no route, and a session whose route
    // advertises no window has no budget either. Opening a runtime first would
    // turn the same state into a thrown error, so the guard comes first.
    const routed = agent.session.requestContext()
    const budget = this.computeBudget(routed?.contextWindow)
    const route = routeOf(agent, routed)
    if (budget === undefined || route === undefined) return null
    const runtime = await this.runtimeFor(agent, route)
    const { session } = agent
    this.syncSurface(runtime, session)
    this.syncToolDefinitions(runtime, session)
    this.feedCalibration(runtime, session)

    if (!await compileFolds(runtime, budget, this.config.reserveTokens, (message) => { this.warn(message) })) return null

    // After the compile, never before: the strategy cuts its compression queue
    // inside `select`, so a tick ahead of the first compile of a session finds
    // an empty queue and forms nothing. This is the one ordering the library
    // imposes on the pass, and it is why a tick is kicked per pass rather than
    // once at open.
    this.kickTick(runtime, session)

    const turn = currentTurn(session)
    const [op] = planFolds(runtime.store, session, {
      resolutions: resolutionsOf(runtime.strategy),
      summaries: summariesOf(runtime.strategy),
      seeded: runtime.known,
      seqOf: runtime.seqOf,
    })
    if (op === undefined) return null
    this.ctx.logger.info(
      `autobiographical compaction: folded ${op.shadowedSeqs.length} node(s) into ${op.summaryId}`,
    )
    return applyFold(session, op, turn, 0, route)
  }

  /**
   * Push the session's assembled tool schemas into the strategy. It defers
   * compressing any chunk holding tool blocks until definitions arrive — a
   * tools-less replay of a tool transcript trips provider refusal classifiers —
   * so a session that never pushed them would never fold at all.
   */
  private syncToolDefinitions(runtime: Runtime, session: Session): void {
    const tools = session.requestHeader()?.tools
    if (tools === undefined) return
    // Both sides are JSON-Schema shaped and the library reads `inputSchema` as an
    // open record, so the schema passes through with the object type forced: the
    // `type` is written last because the harness requires it to be `'object'` and
    // a tool declaring otherwise must not win.
    runtime.manager.setToolDefinitions(tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.parameters, type: 'object' as const },
    })))
  }

  /**
   * Mirror the log events this runtime has not seen. Only append events are
   * taken: a fold node is never mirrored, because the planner folds the ground it
   * shadows rather than the node itself. The cursor is what keeps this idempotent
   * — a fold does not move the surface's older positions, so re-walking them
   * would hand the strategy a second message for ground it already holds and it
   * would compress that ground again on every pass.
   */
  private syncSurface(runtime: Runtime, session: Session): void {
    for (const event of session.events) {
      if (event.seq <= runtime.cursor) continue
      if (!isAppendSurfaceEvent(event)) continue
      const id = appendSurfaceNode(runtime.store, session, event)
      if (id === undefined) continue
      runtime.seqOf.set(id, event.seq)
    }
    runtime.cursor = session.events.at(-1)?.seq ?? runtime.cursor
  }

  /**
   * Let the strategy form memory behind the turn. The chain serializes ticks, so
   * a slow compression call delays the next tick rather than overlapping it, and
   * nothing here is ever awaited by a turn.
   */
  private kickTick(runtime: Runtime, session: Session): void {
    runtime.tickChain = runtime.tickChain
      .then(() => runtime.manager.tick())
      .catch((error: unknown) => { this.warn(`memory formation failed: ${describe(error)}`) })
      .then(() => {
        // The session may have been disposed while the tick ran.
        if (this.runtimes.has(session.id)) this.appendMemory(runtime, session)
      })
  }

  /**
   * Write down every recollection the last tick minted, with the surface span it
   * stands for. These events plus the fold nodes they name are the archive: a
   * replayed log rebuilds the pyramid, so nothing else about a recollection has
   * to survive the process.
   *
   * A tick that minted nothing and finished no call has nothing to say, and
   * saying it anyway would append an identical record on every pass forever.
   */
  private appendMemory(runtime: Runtime, session: Session): void {
    const mint = this.newestMint(runtime)
    if (mint === undefined && runtime.progress.attempt <= attemptFromLog(session)) return
    const usage = runtime.progress.usage
    delete runtime.progress.usage
    session.append('autobio/memory', {
      ...runtime.strategy.getStats(),
      attempt: runtime.progress.attempt,
      ...usage === undefined ? {} : { usage },
      ...mint === undefined ? {} : { memory: mint },
    })
  }

  /**
   * The one recollection this tick minted, recorded with the span of the log it
   * stands for. `autobio/memory` is the only place a recollection's coverage is
   * written down: the fold node carries its text, the pyramid entry can be
   * rebuilt from the replayed surface, but nothing else remembers which events
   * it was distilled from.
   */
  private newestMint(runtime: Runtime): AutobiographicalMemoryMint | undefined {
    for (const summary of summariesOf(runtime.strategy)) {
      if (runtime.announced.has(summary.id)) continue
      const range = resolveRange(runtime.seqOf, summary)
      // A recollection whose ground is not in the store has no coverage to
      // record, and a replayed entry citing nothing is rejected by the strategy's
      // own source validation on the next open, so it is left for a later pass
      // rather than written down ungrounded.
      if (range === undefined) continue
      runtime.announced.add(summary.id)
      runtime.known.set(summary.id, { covered: range, cited: range })
      return {
        id: summary.id,
        level: summary.level,
        content: summary.content,
        tokens: summary.tokens,
        created: summary.created,
        sourceRange: range,
      }
    }
    return undefined
  }

  /**
   * Report the last step's real prompt size, so the estimator learns from the
   * wire. `lastFedSeq` is the high-water mark: usage is fed once per step, and a
   * call that reported none leaves the mark where it is for the next step to find.
   */
  private feedCalibration(runtime: Runtime, session: Session): void {
    for (let index = session.events.length - 1; index > runtime.lastFedSeq; index--) {
      const event = session.events[index]
      if (event?.type !== 'assistant/message') continue
      const usage = event.data.usage
      if (usage === undefined) continue
      runtime.lastFedSeq = event.seq
      runtime.strategy.reportRealInputTokens(
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      )
      return
    }
  }

  /**
   * The compile budget, or nothing when the session has not routed a model yet.
   * The reserve is both the breathing room below the operating window and the
   * response allowance; prompt overhead is not subtracted here because the
   * estimator's calibration multiplier already accounts for it.
   */
  private computeBudget(window: number | undefined): TokenBudget | undefined {
    // A window the route never advertised is not a window of zero and not one of
    // the cap either: the budget is unknown until the session routes.
    if (window === undefined) return undefined
    const maxTokens = Math.min(window, this.config.operatingWindowTokens ?? OPERATING_WINDOW_CAP)
      - this.config.reserveTokens
    return maxTokens <= 0 ? undefined : { maxTokens, reserveForResponse: this.config.reserveTokens }
  }

  /** The session's runtime, seeded from its log and opened once. */
  private runtimeFor(agent: CompactionAgentContext, route: Route): Promise<Runtime> {
    const id = agent.session.id
    const open = this.runtimes.get(id)
    if (open !== undefined) return open
    const opening = this.openRuntime(agent, route)
    this.runtimes.set(id, opening)
    // A failed open must not be cached: the usual failure is an unrouted session,
    // and the next step boundary has a route.
    opening.catch(() => {
      if (this.runtimes.get(id) === opening) this.runtimes.delete(id)
    })
    return opening
  }

  /** Build the in-memory store, replay the log into it, then open the manager. */
  private async openRuntime(agent: CompactionAgentContext, route: Route): Promise<Runtime> {
    const store = createStore()
    const seed = seedFromLog(store, agent.session)
    // `autoTickOnNewMessage` stays off because replay itself appends messages:
    // left on, opening a long session would storm ticks before the first fold.
    const strategy = new AutobiographicalStrategy({
      ...this.config.strategy,
      compressionModel: route.model,
      summaryParticipant: 'assistant',
      adaptiveResolution: true,
      autoTickOnNewMessage: false,
      foldingStrategy: 'kv-stable',
      // The bridge strips reasoning carriers from an emitted fold whenever the
      // strip is smaller, so pairs that do keep carriers must be priced at the
      // stripped render too. The library's default prices them at the stored
      // thinking, overstating every such pair the planner weighs.
      carrierPolicy: 'live-strip',
    })
    const progress: Runtime['progress'] = { attempt: attemptFromLog(agent.session), active: false }
    // No estimator is handed over: the manager's own default is density-aware
    // and its calibration reports against the wire, so a fixed-density one here
    // would only overwrite the first of those.
    const manager = await ContextManager.open({
      // The store is duck-typed by the library at runtime — nothing there
      // `instanceof`-checks it — but its published type is the Chronicle native
      // class, which cannot be implemented structurally and cannot be imported
      // without putting that package back in the manifest. `never` is the one
      // cast that states the mismatch without re-declaring the type: every
      // method the library reaches is modelled in `store.ts`, and the rest
      // throw by name if the library ever moves onto them.
      store: store as never,
      strategy,
      membrane: createBridge({
        llm: this.ctx.llm,
        provider: route.provider,
        warn: (message) => { this.warn(message) },
        onText: (delta, done, usage) => { this.captureText(progress, delta, done, usage) },
      }),
    })
    return {
      manager,
      strategy: manager.getStrategy() as AutobiographicalStrategy,
      store,
      seqOf: seed.seqOf,
      cursor: agent.session.events.at(-1)?.seq ?? -1,
      known: seed.known,
      announced: new Set(seed.known.keys()),
      progress,
      lastFedSeq: -1,
      tickChain: Promise.resolve(),
    }
  }

  /**
   * Record a settled bridge call. The attempt counter advances here and nowhere
   * else, so a replayed log reconstructs it, and `appendMemory` writes the record
   * the counter and usage belong to. Bookkeeping must never kill a compression
   * call, hence the swallow: the session can close mid-call.
   */
  private captureText(
    progress: Runtime['progress'],
    delta: string,
    done: boolean,
    usage: TokenUsage | undefined,
  ): void {
    try {
      progress.active ||= delta.length > 0
      // A call that never streamed text formed no memory, and usage without text
      // is not one either — leave the counter alone so the next tick writes no
      // record. The terminal flush's own delta is always empty, so the verdict
      // comes from the mid-call flushes this flag accumulated.
      if (!done || !progress.active) return
      progress.attempt++
      progress.active = false
      // `exactOptionalPropertyTypes`: absent and `undefined` are not the same
      // property, and a call that reported no usage must not leave the previous
      // call's in place for `appendMemory` to bill twice.
      delete progress.usage
      if (usage !== undefined) progress.usage = usage
    } catch {
      // The session closed under a compression call; the call is already lost.
    }
  }

  /** Diagnostics go to the console as well: headless surfaces drop logger output. */
  private warn(message: string): void {
    const text = `[${name}] ${message}`
    this.ctx.logger.warn(text)
    console.warn(text)
  }
}

/**
 * Compile against the budget, reporting whether the layout reached it. A
 * refusal measured from the route's advertised window is retried once at the
 * size the strategy could actually reach.
 */
async function compileFolds(
  runtime: Runtime,
  budget: TokenBudget,
  reserveTokens: number,
  warn: (message: string) => void,
): Promise<boolean> {
  try {
    await runtime.manager.compile(budget)
    return true
  } catch (error: unknown) {
    if (!(error instanceof OverBudgetError)) throw error
    // Worth one retry only when the size the strategy could actually reach
    // exceeds the budget being claimed.
    const affordable = error.actual + reserveTokens
    if (affordable <= budget.maxTokens) return over(error, budget.maxTokens, warn)
    try {
      await runtime.manager.compile({ maxTokens: affordable, reserveForResponse: reserveTokens })
      return true
    } catch (retry: unknown) {
      if (!(retry instanceof OverBudgetError)) throw retry
      return over(retry, retry.budget, warn)
    }
  }
}

/** The picker wants more folds than one pass commits; the excess is the queue. */
function over(error: OverBudgetError, budget: number, warn: (message: string) => void): false {
  warn(`folding is ${error.actual} tokens over budget ${budget}; folding again next step`)
  return false
}

/** The provider and model a compression call is routed to. */
interface Route {
  provider: string
  model: string
}

/** The session's current route: the newest durable request, else the agent's options. */
function routeOf(agent: CompactionAgentContext, routed: RequestContext | undefined): Route | undefined {
  if (routed !== undefined) return { provider: routed.provider, model: routed.model }
  const { provider, model } = agent.options
  if (!provider || !model) return undefined
  return { provider, model }
}

/** The session's latest started turn, for fold-node attribution outside a live step. */
function currentTurn(session: Session): number | null {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type === 'turn/start') return event.data.turn
  }
  return null
}

/**
 * The attempt count a replayed log already recorded. A reopened session resumes
 * the counter from the log rather than from zero, so a tick that finishes no
 * call has nothing new to report and writes nothing.
 */
function attemptFromLog(session: Session): number {
  let attempt = 0
  for (const event of session.events) {
    if (event.type === 'autobio/memory') attempt = Math.max(attempt, event.data.attempt)
  }
  return attempt
}

/**
 * The strategy's committed resolutions and minted recollections. Both are
 * `protected` upstream, and both are the seam the library's own connectome UI
 * reads, so the access is deliberate rather than incidental: there is no public
 * accessor for either, and a fold needs both to know what the picker decided.
 */
function resolutionsOf(strategy: AutobiographicalStrategy): Map<string, number> {
  return (strategy as unknown as { resolutions: Map<string, number> }).resolutions
}

/** See {@link resolutionsOf}. */
function summariesOf(strategy: AutobiographicalStrategy): SummaryEntry[] {
  return (strategy as unknown as { summaries: SummaryEntry[] }).summaries
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default AutobiographicalCompactionEngine
