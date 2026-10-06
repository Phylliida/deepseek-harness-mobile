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
import type { TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { RequestContext, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
// Type-only: resolves the `sessionProjections` Context declaration the
// compactionConfig projection registers into.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves the token meter's Context declaration, which the planner's
// node price comes from.
import type {} from '@deepseek-ai/dsh-token-meter'
import { applyFolds } from './apply.ts'
import { createBridge } from './bridge.ts'
import { resolveConfig } from './config.ts'
import { DivergenceError, planFolds, priceSurfaceNode } from './plan.ts'
import { compactionConfigProjectionDefinition } from './projection.ts'
import { appendSurfaceNode, recollectionRows, resolveRange, seedFromLog } from './seed.ts'
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
export const inject = ['llm', 'tokenMeter']

/** Streamed characters buffered before one live record is appended: a record per chunk would put a token-size row in the durable log. */
const PROGRESS_FLUSH_CHARS = 1000

/**
 * Where one folding pass runs, and what may cancel it.
 *
 * The bracket a fold lands in needs an owner the compaction invariant accepts:
 * the open turn with the step this pass is preparing, or `null` between turns,
 * which is the standalone shape a manual pass writes.
 */
interface Pass {
  /** Turn the fold's bracket belongs to, or `null` outside a turn. */
  readonly turn: number | null
  /** Step within that turn the replacement message is stamped with. */
  readonly step: number
  /** Cancellation for the calls this pass kicks. */
  readonly signal?: AbortSignal
}

/** The live context-manager stack for one session. */
interface Runtime {
  manager: ContextManager
  store: LogStore
  strategy: AutobiographicalStrategy
  /**
   * The route the runtime was opened with. A recollection's voice is frozen at
   * open, so the same value stamps the fold node's provenance rather than the
   * route the landing pass happens to read.
   */
  route: RequestContext
  /**
   * Log seq coverage per recollection the log has announced. Presence is also
   * the record that it was announced: the coverage is written at the same moment
   * the recollection is, so a set beside this map would hold the same keys.
   */
  known: Map<string, RecollectionRange>
  /** Log seq behind each mirrored message id. */
  seqOf: Map<string, number>
  /**
   * Index of the newest log event mirrored into the store. Replay leaves it at
   * the log's end, so a live pass only ever walks what arrived since.
   */
  walked: number
  /**
   * The attempt counter this runtime has reached, the usage every call since the
   * last record reported, the text the current call has streamed since the last
   * live record, and whether it streamed any text — the terminal flush carries an
   * empty delta, so only the mid-call flushes prove a call produced something.
   */
  progress: { attempt: number; active: boolean; buffer: string; usage: TokenUsage | undefined }
  /**
   * Cancellation the memory-formation calls of the newest kicked tick run under.
   * The bridge reads it when a call starts: the tick runs after the pass that
   * kicked it has returned, so the signal has to outlive that pass.
   */
  cancellation: { signal: AbortSignal | undefined }
  /** The tool declaration set the strategy was last handed, by identity. */
  declaredTools: readonly ToolSchema[] | undefined
  /** The system prompt the strategy was last handed. */
  declaredSystem: string | undefined
  /**
   * The attempt count the newest record in the log reports. Replay seeds it from
   * the log and every write moves it forward, so a tick that finishes no call
   * leaves `progress.attempt` here and writes nothing — which is what keeps a
   * driven pass from writing the same attempt down again and again.
   */
  recorded: number
  /** Seq of the newest event fed to calibration, so one usage is reported once. */
  calibrated: number
  /** Background work chain; a turn never awaits it. */
  tickChain: Promise<void>
}

/**
 * The strategy's protected state this backend reads: the picker's committed
 * resolutions, and the recollections it has minted.
 */
interface Internals {
  resolutions: Map<string, number>
  summaries: SummaryEntry[]
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
     * The window the compile budget is measured against, reached by folding aged
     * history. Default 65_536.
     *
     * The budget is `min(routed window, this) − reserveTokens`, and the library
     * subtracts `reserveTokens` again as the response allowance, so the live
     * context is held below this less twice the reserve: the second subtraction
     * is the headroom the harness's own request envelope — system prompt, tool
     * schemas — needs, which the strategy never sees. The double subtraction
     * fails by folding early, never by overflowing.
     */
    operatingWindowTokens: Schema.number().step(1).min(1),
    /**
     * Tokens kept out of the live context for the response. Default 8192.
     *
     * It is subtracted twice: once as breathing room below the operating window
     * and again by the library, which reserves it for the model's response
     * inside its own budget arithmetic.
     */
    reserveTokens: Schema.number().step(1).min(0).default(8192),
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
    // Fold aged history before the next request is derived. A failure is loud on
    // the console and never stops the turn: the strategy replans from the log on
    // every compile, so the next step boundary is a complete retry.
    if (this.config.auto) {
      ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
        try {
          await this.foldPass(agent, { turn, step, signal })
        } catch (error: unknown) {
          this.warn(`folding failed: ${describe(error)}; continuing the turn`)
        }
        return next()
      })
    }
    // Dropping the runtime is the whole of disposal. `ContextManager.close()`
    // calls the store's `close` only when the manager opened it itself, and this
    // backend always hands its own store in, so there is nothing to close — and
    // the map entry is the only thing holding the seeded store alive.
    ctx.on('agent/disposed', ({ agent }) => {
      this.runtimes.delete(agent.session.id)
    })
    ctx.effect(() => () => { this.runtimes.clear() }, 'compaction-autobiographical.disposal')

    // The session's memory settings ride the log as `compaction/config` events;
    // the projection puts the newest of them where the GUI reads it.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(compactionConfigProjectionDefinition)
    })
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    _trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    try {
      // No step is proposed on this entry, so the bracket is owned by whatever
      // turn the log holds open — the shape the invariant accepts — and carries
      // no step of its own.
      return await this.foldPass(agent, { turn: openTurn(agent.session), step: 0, signal })
    } catch (error: unknown) {
      throw manualFailure(error)
    }
  }

  override async compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    _sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    let claimed: Promise<CompactionResult | null>
    try {
      // The idle reservation is what keeps a manual pass from racing a turn, and
      // a claim the agent refuses is the busy case rather than a fold failure.
      claimed = agent.runMaintenance(maintenance => this.foldPass(agent, {
        // A manual pass runs on an idle agent, so its bracket is standalone and
        // the invariant refuses a numbered owner beside it.
        turn: null,
        step: 0,
        // The maintenance claim ends with the idle reservation and this signal
        // with the request, so a cancellation either way has to reach the calls
        // the pass kicks.
        signal: AbortSignal.any([maintenance, signal]),
      }))
    } catch (error: unknown) {
      throw new ManualCompactionError('busy', 'manual compaction requires an idle agent', { cause: error })
    }
    try {
      return await claimed
    } catch (error: unknown) {
      throw manualFailure(error)
    }
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
   * One folding pass: replay what the log gained, kick memory formation off the
   * turn's critical path, report the last step's real prompt size, then compile
   * and write down the layout the strategy reached.
   *
   * Compiling is what commits the picker's resolutions, so it runs before
   * planning rather than only at request time. Nothing here waits on a model:
   * `compile` reads the store, and folding already happened in the form of
   * recollections the last ticks minted.
   */
  private async foldPass(agent: CompactionAgentContext, pass: Pass): Promise<CompactionResult | null> {
    // All three refusals are the session's to fix, not the pass's to fail: a
    // session that has not routed has no route, one whose route advertises no
    // window has no window, and one whose window is no larger than the reserve has
    // no room to fold into. Opening a runtime first would turn the same state into
    // a thrown error, so the guard comes first.
    const routed = agent.session.requestContext()
    if (routed?.contextWindow === undefined) return null
    const settings = sessionConfig(agent.session)
    // A session whose memory the user paused folds nothing and forms nothing:
    // the pass leaves the log and the strategy exactly as it found them, and
    // formation catches up on the first pass after the pause lifts.
    if (settings.enabled === false) return null
    const budget = this.computeBudget(routed.contextWindow, settings.operatingWindowTokens ?? undefined)
    if (budget === undefined) return null
    const runtime = await this.runtimeFor(agent, routed)
    const { session } = agent
    this.syncSurface(runtime, session)
    this.syncToolDefinitions(runtime, session)
    this.feedCalibration(runtime, session)

    const reached = await compileFolds(runtime, budget, this.config.reserveTokens, (message) => { this.warn(message) })

    // After the compile attempt, never before: the strategy cuts its compression
    // queue inside `select`, so a tick ahead of the first compile of a session
    // finds an empty queue and forms nothing. This is the one ordering the library
    // imposes on the pass, and it is why a tick is kicked per pass rather than
    // once at open. A refusal is not an exception to it: compressing is what
    // raises the floor the next compile finds, so a session over budget has to
    // keep forming memory or it stays over budget for good.
    this.kickTick(runtime, session, pass.signal)
    if (!reached) return null

    const { resolutions, summaries } = internals(runtime.strategy)
    // Every op the picker committed lands in this pass, one bracket each: the
    // compaction protocol allows exactly one summary per bracket, so a pass that
    // folds several regions writes several transactions.
    const ops = planFolds(runtime.store, session, {
      resolutions,
      summaries,
      seeded: runtime.known,
      seqOf: runtime.seqOf,
      // The fold's shadow price is the meter's own node price, so the surface
      // delta it is delta-accounted against is measured with one estimator.
      price: priceSurfaceNode,
    })
    if (ops.length === 0) return null
    this.ctx.logger.info(
      `autobiographical compaction: folded ${ops.reduce((total, op) => total + op.shadowedSeqs.length, 0)} node(s) `
      + `into ${ops.length} recollection(s)`,
    )
    // The seam reports one result per pass, so it takes the recollection that
    // landed last; the log carries a bracket for every op either way.
    return applyFolds(session, ops, pass.turn, pass.step, runtime.route).at(-1) as CompactionResult
  }

  /**
   * Push the session's assembled tool schemas and system prompt into the
   * strategy, each on the pass that first sees it. The strategy defers
   * compressing any chunk holding tool blocks until definitions arrive — a
   * tools-less replay of a tool transcript trips provider refusal classifiers —
   * so a session that never pushed them would never fold at all, and the
   * memory-writing call is served the session's system voice only if the prompt
   * is pushed too.
   */
  private syncToolDefinitions(runtime: Runtime, session: Session): void {
    // The header fold is one object per header the log holds, so identity is the
    // change check: a pass that finds the same object has nothing to push.
    const header = session.requestHeader()
    const tools = header?.tools
    if (tools !== undefined && tools !== runtime.declaredTools) {
      runtime.declaredTools = tools
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
    // A declaration set the session drops is not retracted: the library's own
    // setter ignores an empty list, so a session that declares no tools leaves
    // the strategy holding the last set it saw.
    const system = header?.system
    if (system !== undefined && system !== runtime.declaredSystem) {
      runtime.declaredSystem = system
      runtime.manager.setSystemPrompt(system)
    }
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
    for (let index = runtime.walked + 1; index < session.events.length; index++) {
      const event = session.events[index] as SessionEvent
      runtime.walked = index
      if (!isAppendSurfaceEvent(event)) continue
      const id = appendSurfaceNode(runtime.manager, session, event)
      if (id === undefined) continue
      runtime.seqOf.set(id, event.seq)
    }
  }

  /**
   * Let the strategy form memory behind the turn. The chain serializes ticks, so
   * a slow compression call delays the next tick rather than overlapping it, and
   * nothing here is ever awaited by a turn.
   */
  private kickTick(runtime: Runtime, session: Session, signal?: AbortSignal): void {
    // The calls this tick makes read the cancellation when they start, which is
    // what carries a turn abort or a cancelled `/compact` into a stream that is
    // already paying for itself.
    runtime.cancellation.signal = signal
    // The record is written on both paths, and before the failure is reported.
    // That order is the point: the attempt counter advances inside the compression
    // call, so a tick that failed *after* that advance holds a count the log can
    // only learn from its record. Skipping it would leave `attemptFromLog` short
    // and make every later record inherit the error. The write is a no-op unless
    // the count moved, since `appendMemory` returns before writing when no
    // recollection appeared and the attempt is still at the watermark.
    const settle = (): void => {
      // The session may have been disposed while the tick ran.
      if (this.runtimes.has(session.id)) this.appendMemory(runtime, session)
    }
    runtime.tickChain = runtime.tickChain
      .then(() => runtime.manager.tick())
      .then(
        () => { settle() },
        (error: unknown) => {
          settle()
          this.warn(`memory formation failed: ${describe(error)}`)
        },
      )
  }

  /**
   * Write down the recollection the last tick minted, or the call it finished,
   * with the surface span the recollection stands for. These events plus the fold
   * nodes they name are the archive: a replayed log rebuilds the pyramid, so
   * nothing else about a recollection has to survive the process.
   *
   * A tick that neither minted nor finished a call has nothing to say, and saying
   * it anyway would append an identical record on every pass forever.
   *
   * The record carries values this engine does not construct — the strategy's
   * counters, the recollection the library minted, the calls' reported usage — and
   * the log accepts lossless JSON only. A record that cannot cross that boundary
   * is reported and not written, counters included: it is a bug in what feeds the
   * record, and the console line is the whole evidence for it. Guessing at the
   * value would hide the bug and write a record the reader can no longer trust.
   */
  private appendMemory(runtime: Runtime, session: Session): void {
    const found = this.newestMint(runtime)
    const mint = found?.mint
    if (mint === undefined && runtime.progress.attempt <= runtime.recorded) return
    const { progress } = runtime
    const usage = progress.usage
    const { attempt } = progress
    // The count this record names is the one a reopen seeds the counter from, so a
    // record that cannot carry a count is refused here rather than written: storing
    // it would leave a session that reads back a counter it cannot be resumed from,
    // and every record after it would inherit the same count.
    if (!Number.isFinite(attempt)) {
      this.warn(`refusing to record a call settled at attempt ${String(attempt)}; the counter is not a number`)
      return
    }
    progress.usage = undefined
    const data = {
      ...runtime.strategy.getStats(),
      attempt,
      ...usage === undefined ? {} : { usage },
      ...mint === undefined ? {} : { memory: mint },
    }
    try {
      session.append('autobio/memory', data)
    } catch (error: unknown) {
      // The record is the archive's only account of this tick, so a refusal is
      // reported whole — what was being written, and whether the log could store
      // any of it at all. `isJsonValue` is the same boundary the log applies, so
      // the report cannot throw on the value it is judging.
      this.warn(`the memory record for attempt ${attempt} was refused: ${describe(error)}`)
      if (!isJsonValue(data)) this.warn('  the record holds a value the session log cannot store')
      this.warn(`  data: ${bounded(JSON.stringify(data))}`)
      return
    }
    // Both markers move only once the record is durable: the count is what a
    // reopen resumes from, and the coverage is the recollection's only account of
    // the span it stands for. A recollection marked announced by a refused record
    // is never announced again, which loses it from the archive for good.
    runtime.recorded = attempt
    if (found !== undefined) runtime.known.set(found.mint.id, found.range)
  }

  /**
   * The one recollection this tick minted, recorded with the span of the log it
   * stands for. `autobio/memory` is the only place a recollection's coverage is
   * written down: the fold node carries its text, the pyramid entry can be
   * rebuilt from the replayed surface, but nothing else remembers which events
   * it was distilled from.
   */
  private newestMint(runtime: Runtime): { mint: AutobiographicalMemoryMint; range: RecollectionRange } | undefined {
    for (const summary of internals(runtime.strategy).summaries) {
      if (runtime.known.has(summary.id)) continue
      const range = resolveRange(runtime.seqOf, summary, recollectionRows(runtime.store))
      // A recollection whose ground is not in the store has no coverage to
      // record, and a replayed entry citing nothing is rejected by the strategy's
      // own source validation on the next open, so it is left for a later pass
      // rather than written down ungrounded.
      if (range === undefined) continue
      return { mint: createMint(summary, range), range: { covered: range, cited: range } }
    }
    return undefined
  }

  /**
   * Report the last step's real prompt size, so the estimator learns from the
   * wire. `calibrated` is the high-water mark: usage is fed once per step, and a
   * call that reported none leaves the mark where it is for the next step to find.
   */
  private feedCalibration(runtime: Runtime, session: Session): void {
    const sized = newestUsage(session)
    if (sized === undefined || sized.seq <= runtime.calibrated) return
    runtime.calibrated = sized.seq
    const { usage } = sized
    runtime.strategy.reportRealInputTokens(
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    )
  }

  /**
   * The compile budget, or nothing when the session has not routed a model yet.
   * The reserve is the breathing room below the operating window, and the library
   * subtracts it again inside its own arithmetic as the response allowance, so the
   * live context it holds is the smaller of the route's window and the configured
   * one — or the session's own `compaction/config` override when the user set one —
   * less twice the reserve. Prompt overhead is not subtracted here beyond
   * that because the estimator's calibration multiplier already accounts for it.
   */
  private computeBudget(window: number, operatingWindowTokens?: number): TokenBudget | undefined {
    const maxTokens = Math.min(window, operatingWindowTokens ?? this.config.operatingWindowTokens) - this.config.reserveTokens
    return maxTokens <= 0 ? undefined : { maxTokens, reserveForResponse: this.config.reserveTokens }
  }

  /** The session's runtime, seeded from its log and opened once. */
  private runtimeFor(agent: CompactionAgentContext, route: RequestContext): Promise<Runtime> {
    const id = agent.session.id
    const open = this.runtimes.get(id)
    if (open !== undefined) return open
    const opening = this.openRuntime(agent, route)
    this.runtimes.set(id, opening)
    // A failed open must not be cached: the usual failure is an unrouted session,
    // and the next step boundary has a route. It must not evict a runtime opened
    // since, either — a disposal during this open drops the entry, the session
    // opens another, and deleting whatever the map holds then would leave a live
    // runtime to be rebuilt from the log on the next pass. The comparison is what
    // tells the two apart, and `disposal` covers the sequence.
    opening.catch(() => {
      if (this.runtimes.get(id) === opening) this.runtimes.delete(id)
    })
    return opening
  }

  /** Build the in-memory store, replay the log into it, then open the manager. */
  private async openRuntime(agent: CompactionAgentContext, route: RequestContext): Promise<Runtime> {
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
    const recorded = attemptFromLog(agent.session)
    const progress: Runtime['progress'] = { attempt: recorded, active: false, buffer: '', usage: undefined }
    const cancellation: Runtime['cancellation'] = { signal: undefined }
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
        // Read per call rather than captured: the tick that makes the call runs
        // after the pass that kicked it has returned.
        signal: () => cancellation.signal,
        onText: (delta, done, usage, failure) => {
          this.captureText(agent.session, progress, delta, done, usage, failure)
        },
      }),
    })
    return {
      manager,
      strategy: manager.getStrategy() as AutobiographicalStrategy,
      store,
      route,
      seqOf: seed.seqOf,
      walked: agent.session.events.length - 1,
      known: seed.known,
      progress,
      cancellation,
      declaredTools: undefined,
      declaredSystem: undefined,
      recorded,
      calibrated: 0,
      tickChain: Promise.resolve(),
    }
  }

  /**
   * Record a bridge call's streamed text and, on the terminal flush, its usage
   * and the failure it ended with. The attempt counter advances when a call first
   * shows up — with text, or with a failure on the terminal flush — so a live
   * record and the tick record that settles the call report one attempt.
   */
  private captureText(
    session: Session,
    progress: Runtime['progress'],
    delta: string,
    done: boolean,
    usage: TokenUsage | undefined,
    failure: string | undefined,
  ): void {
    if (!progress.active) {
      // A call that streamed nothing and failed still happened, and constraint
      // one is that every request shows up: it takes an attempt number so its row
      // exists, with nothing in it but the failure.
      if (delta.length === 0 && failure === undefined) return
      progress.active = true
      progress.attempt++
    }
    progress.buffer += delta
    if (done || progress.buffer.length >= PROGRESS_FLUSH_CHARS) {
      try {
        session.append('autobio/memory-progress', {
          attempt: progress.attempt,
          delta: progress.buffer,
          ...done ? { done: true } : {},
          ...failure === undefined ? {} : { error: failure },
        })
      } catch {
        // A session that closed mid-call costs this flush, not the call.
      }
      progress.buffer = ''
    }
    if (!done) return
    progress.active = false
    // A tick may settle more than one call — the library's refusal ladder streams
    // its way through several — so every call's usage adds up here rather than the
    // last one standing for the tick.
    progress.usage = addUsage(progress.usage, usage)
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
 * refusal is retried once at the size the strategy could actually reach.
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
    // The size the strategy could actually reach, converted back into a total
    // budget: `actual` is measured against the usable budget the library derived,
    // which is the total less the response allowance.
    const affordable = error.actual + reserveTokens
    try {
      await runtime.manager.compile({ maxTokens: affordable, reserveForResponse: reserveTokens })
      return true
    } catch (retry: unknown) {
      /* v8 ignore next -- every refusal reports an `actual` above the budget it was
         measured against, so `affordable` is strictly larger than the budget the first
         call already refused: a retry at that size cannot refuse for size. Anything else
         it throws belongs to the caller. */
      if (!(retry instanceof OverBudgetError)) throw retry
      return over(retry, warn)
    }
  }
}

/**
 * Report a refusal the retry could not fit and give up on the pass's folds: the
 * next step compiles again. The refusal's `actual` and `budget` are both measured
 * on the library's usable budget, so the two are comparable and neither is the
 * total the pass asked for.
 */
function over(error: OverBudgetError, warn: (message: string) => void): false {
  warn(`folding is ${error.actual} tokens over budget ${error.budget}; folding again next step`)
  return false
}

/**
 * The session's open turn, or `null` between turns. A turn the log has closed is
 * closed for good: the compaction invariant refuses a bracket owned by it, and
 * one written under it outlives the turn it claims.
 */
function openTurn(session: Session): number | null {
  const boundary = session.events
    .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return boundary?.type === 'turn/start' ? boundary.data.turn : null
}

/**
 * The session's memory settings from its newest `compaction/config` event, both
 * knobs unset before one lands. Read per pass rather than held: the event may
 * land between passes, and the pass is the only place the knobs act.
 */
function sessionConfig(session: Session): { enabled?: boolean; operatingWindowTokens?: number | null } {
  return session.events.findLast(event => event.type === 'compaction/config')?.data ?? {}
}

/**
 * One call's reported usage added to the total this tick has settled so far, or
 * the call's own usage when it is the first. Fields only the provider reports on
 * some calls stay absent until one reports them, so a tick whose calls reported
 * none keeps the totals shape the usage projection reads.
 */
function addUsage(total: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (next === undefined) return total
  if (total === undefined) return next
  const added = total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined
  const written = total.cacheWriteTokens !== undefined || next.cacheWriteTokens !== undefined
  const thought = total.reasoningTokens !== undefined || next.reasoningTokens !== undefined
  const billed = total.costUsd !== undefined || next.costUsd !== undefined
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...added ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) } : {},
    ...written ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) } : {},
    ...thought ? { reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) } : {},
    ...billed ? { costUsd: (total.costUsd ?? 0) + (next.costUsd ?? 0) } : {},
  }
}

/**
 * A thrown fold pass as the seam's own failure class. `/compact` reports an
 * expected failure to its caller and rethrows anything else as an unexpected
 * one, so a planning or compile failure has to arrive classified: a divergence
 * is the surface having moved under the plan, and everything else is the pass
 * failing to produce a fold.
 */
function manualFailure(error: unknown): ManualCompactionError {
  return error instanceof DivergenceError
    ? new ManualCompactionError('changed', describe(error), { cause: error })
    : new ManualCompactionError('summary', describe(error), { cause: error })
}

/** The newest assistant step that reported usage, and the seq it reported at. */
function newestUsage(session: Session): { seq: number; usage: TokenUsage } | undefined {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type !== 'assistant/message') continue
    if (event.data.usage !== undefined) return { seq: event.seq, usage: event.data.usage }
  }
  return undefined
}

/**
 * The attempt count the log already recorded, read once when a runtime opens. A
 * replayed session resumes the counter from the log rather than from zero, so a
 * tick that finishes no call has nothing new to report and writes nothing.
 *
 * Records that do not name a count are skipped rather than read as one, because
 * a count that is not a number poisons the counter it seeds: `Math.max(0, NaN)`
 * is `NaN`, which is what every later record would then report, and a session
 * that opens on one is wedged for good. Sessions written before a record carried
 * a count hold such events, so this reads the newest count instead of folding
 * every event into a maximum.
 */
function attemptFromLog(session: Session): number {
  let attempt = 0
  for (const event of session.events) {
    if (event.type !== 'autobio/memory') continue
    const recorded = event.data.attempt as unknown
    if (typeof recorded === 'number' && Number.isFinite(recorded)) attempt = Math.max(attempt, recorded)
  }
  return attempt
}

/** One recollection as the log records it, with the span of log it stands for. */
function createMint(summary: SummaryEntry, range: { firstSeq: number; lastSeq: number }): AutobiographicalMemoryMint {
  return {
    id: summary.id,
    level: summary.level,
    content: summary.content,
    tokens: summary.tokens,
    created: summary.created,
    sourceRange: { firstSeq: range.firstSeq, lastSeq: range.lastSeq },
  }
}

/**
 * The strategy's committed resolutions and minted recollections. Both are
 * `protected` upstream, and both are the seam the library's own connectome UI
 * reads, so the access is deliberate rather than incidental: there is no public
 * accessor for either, and a fold needs both to know what the picker decided.
 */
function internals(strategy: AutobiographicalStrategy): Internals {
  return strategy as unknown as Internals
}

/** A console line's worth of text, so one refused record cannot flood the log. */
function bounded(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default AutobiographicalCompactionEngine
