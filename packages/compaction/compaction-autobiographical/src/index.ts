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
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { RequestContext, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { applyFold } from './apply.ts'
import { createBridge } from './bridge.ts'
import { resolveConfig } from './config.ts'
import { planFolds } from './plan.ts'
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
export const inject = ['llm']

/** Streamed characters buffered before one live record is appended: a record per chunk would put a token-size row in the durable log. */
const PROGRESS_FLUSH_CHARS = 1000

/** The live context-manager stack for one session. */
interface Runtime {
  manager: ContextManager
  store: LogStore
  strategy: AutobiographicalStrategy
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
   * The attempt counter this runtime has reached, this call's usage, the text it
   * has streamed since the last live record, and whether the call streamed any
   * text — the terminal flush carries an empty delta, so only the mid-call
   * flushes prove a call produced something.
   */
  progress: { attempt: number; active: boolean; buffer: string; usage?: TokenUsage }
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
     * Ceiling for the live context the strategy keeps, reached by folding aged
     * history. Default 65_536.
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
    // Fold aged history before the next request is derived. A failure is loud on
    // the console and never stops the turn: the strategy replans from the log on
    // every compile, so the next step boundary is a complete retry.
    if (this.config.auto) {
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        try {
          await this.foldPass(agent)
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
    // All three refusals are the session's to fix, not the pass's to fail: a
    // session that has not routed has no route, one whose route advertises no
    // window has no window, and one whose window is no larger than the reserve has
    // no room to fold into. Opening a runtime first would turn the same state into
    // a thrown error, so the guard comes first.
    const routed = agent.session.requestContext()
    if (routed?.contextWindow === undefined) return null
    const budget = this.computeBudget(routed.contextWindow)
    if (budget === undefined) return null
    const runtime = await this.runtimeFor(agent, routed)
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
    const { resolutions, summaries } = internals(runtime.strategy)
    const [op] = planFolds(runtime.store, session, {
      resolutions,
      summaries,
      seeded: runtime.known,
      seqOf: runtime.seqOf,
    })
    if (op === undefined) return null
    this.ctx.logger.info(
      `autobiographical compaction: folded ${op.shadowedSeqs.length} node(s) into ${op.summaryId}`,
    )
    return applyFold(session, op, turn, 0, routed)
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
  private kickTick(runtime: Runtime, session: Session): void {
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
   * counters, the recollection the library minted, the call's reported usage — and
   * the log accepts lossless JSON only. A record that cannot cross that boundary
   * is reported in full and not written, counters included: it is a bug in what
   * feeds the record, and the console line is the whole evidence for it. Guessing
   * at the value would hide the bug and write a record the reader can no longer
   * trust.
   */
  private appendMemory(runtime: Runtime, session: Session): void {
    const mint = this.newestMint(runtime)
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
    delete progress.usage
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
      // reported whole — what was being written, and which value in it the log
      // could not store. Dropping one field or writing a coerced one would leave
      // a record that reads as complete and is not.
      this.warn(`the memory record for attempt ${attempt} was refused: ${describe(error)}`)
      for (const line of describeJsonFailures(data)) this.warn(`  unsupported value: ${line}`)
      this.warn(`  data: ${bounded(JSON.stringify(data))}`)
      return
    }
    // Only a record the log holds is a count a reopen can read back, so the field
    // moves after the write rather than before it.
    runtime.recorded = attempt
  }

  /**
   * The one recollection this tick minted, recorded with the span of the log it
   * stands for. `autobio/memory` is the only place a recollection's coverage is
   * written down: the fold node carries its text, the pyramid entry can be
   * rebuilt from the replayed surface, but nothing else remembers which events
   * it was distilled from.
   */
  private newestMint(runtime: Runtime): AutobiographicalMemoryMint | undefined {
    for (const summary of internals(runtime.strategy).summaries) {
      if (runtime.known.has(summary.id)) continue
      const range = resolveRange(runtime.seqOf, summary, recollectionRows(runtime.store))
      // A recollection whose ground is not in the store has no coverage to
      // record, and a replayed entry citing nothing is rejected by the strategy's
      // own source validation on the next open, so it is left for a later pass
      // rather than written down ungrounded.
      if (range === undefined) continue
      runtime.known.set(summary.id, { covered: range, cited: range })
      return createMint(summary, range)
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
   * The reserve is both the breathing room below the operating window and the
   * response allowance; prompt overhead is not subtracted here because the
   * estimator's calibration multiplier already accounts for it.
   */
  private computeBudget(window: number): TokenBudget | undefined {
    const maxTokens = Math.min(window, this.config.operatingWindowTokens) - this.config.reserveTokens
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
    const progress: Runtime['progress'] = { attempt: recorded, active: false, buffer: '' }
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
        onText: (delta, done, usage) => { this.captureText(agent.session, progress, delta, done, usage) },
      }),
    })
    return {
      manager,
      strategy: manager.getStrategy() as AutobiographicalStrategy,
      store,
      seqOf: seed.seqOf,
      walked: agent.session.events.length - 1,
      known: seed.known,
      progress,
      recorded,
      calibrated: 0,
      tickChain: Promise.resolve(),
    }
  }

  /**
   * Record a bridge call's streamed text and, on the terminal flush, its usage.
   * The attempt counter advances when a call first streams text, so the live
   * records and the tick record that settles the call report one attempt.
   */
  private captureText(
    session: Session,
    progress: Runtime['progress'],
    delta: string,
    done: boolean,
    usage: TokenUsage | undefined,
  ): void {
    if (!progress.active) {
      // The terminal flush carries an empty delta, so a call that never streamed
      // one formed no memory: it takes no attempt number and leaves no record.
      if (delta.length === 0) return
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
        })
      } catch {
        // A session that closed mid-call costs this flush, not the call.
      }
      progress.buffer = ''
    }
    if (!done) return
    progress.active = false
    // `exactOptionalPropertyTypes`: absent and `undefined` are not the same
    // property, and a call that reported no usage must not leave the previous
    // call's in place for `appendMemory` to bill twice.
    delete progress.usage
    if (usage !== undefined) progress.usage = usage
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
      /* v8 ignore next -- every refusal reports an `actual` above the budget it was
         measured against, so `affordable` is strictly larger than the budget the first
         call already refused: a retry at that size cannot refuse for size. Anything else
         it throws belongs to the caller. */
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

/** The session's latest started turn, for fold-node attribution outside a live step. */
function currentTurn(session: Session): number | null {
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event?.type === 'turn/start') return event.data.turn
  }
  return null
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

/**
 * Every value in a record the session log cannot store, as console lines: where
 * each one sits, what it is, and the value itself. The record's own
 * `JSON.stringify` renders `NaN` and `undefined` as `null`, so the report says
 * what the value actually is rather than what that text would show.
 *
 * Exported for its own spec: the tick's record is built from values the library
 * hands over, and a spec that has to make the log refuse one cannot reach the
 * readings this function exists to produce.
 *
 * @param data - the record the log refused.
 * @returns one line per offending field, or that the record itself is storable
 *   and the refusal came from elsewhere.
 */
export function describeJsonFailures(data: unknown): string[] {
  const found = unstorableFields(data, '')
  if (found.length === 0) return ['none — every value in the record is storable JSON']
  return found.map(({ path, value }) => `${path} is ${describeValue(value)}`)
}

/** Every field the lossless-JSON boundary refuses, reported by path. */
function unstorableFields(value: unknown, path: string): { path: string; value: unknown }[] {
  if (isJsonValue(value)) return []
  // Only a record or a list has fields to walk into. An exotic object is refused
  // for what it is, and what it holds is not the log's business.
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unstorableFields(item, `${path}${index}.`))
  }
  if (value !== null && typeof value === 'object' && value.constructor.name === 'Object') {
    return Object.entries(value).flatMap(([key, item]) => unstorableFields(item, `${path}${key}.`))
  }
  return [{ path: path === '' ? '<the record itself>' : path.replace(/\.$/, ''), value }]
}

/**
 * A value as a console line can show it: what it is, and its own text where that
 * text means something. A value that came out of an exotic object or a function
 * is named by what it is, because its JSON text is `{}` or nothing at all.
 *
 * @param value - the value the log refused.
 * @returns the value's type and text, truncated to a line's worth.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return `a non-finite number (${String(value)})`
  if (typeof value === 'function') return `a function (${value.name})`
  // `JSON.stringify` passes straight through a string, so its own quotes say it
  // is one; only the text has to be bounded.
  if (typeof value === 'string') return value.length > 300 ? `${JSON.stringify(value.slice(0, 300))}…` : JSON.stringify(value)
  if (typeof value === 'object') {
    // The log refuses an exotic object for what it is, not for its text, and an
    // object whose `toJSON` writes the text has no business in a durable field.
    return value.constructor.name === 'Object'
      ? `an object the log cannot store: ${bounded(JSON.stringify(value))}`
      : `a ${value.constructor.name}`
  }
  /* v8 ignore next -- the boundary refuses null, booleans, numbers, strings,
     arrays, plain objects, and exotic objects; the readings above are every value
     it can name but the boundary's own reading of it. */
  return 'a symbol the log cannot store'
}

/** A console line's worth of text, so one refused record cannot flood the log. */
function bounded(text: string): string {
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default AutobiographicalCompactionEngine
