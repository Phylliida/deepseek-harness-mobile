/**
 * Autobiographical compaction backend: continuous, hierarchical memory
 * formation driven by the Anima Connectome context-manager's
 * `AutobiographicalStrategy` (adaptive resolution, kv-stable folding). Where
 * the basic backend compacts once under pressure, this backend folds aged
 * chunks into first-person recollections every step, so session length is
 * unbounded and the fold schedule is cache-aware.
 *
 * The harness session log remains the source of truth. The strategy plans
 * over a Chronicle-backed mirror; each planned fold lands as one
 * `assistant/message` replace node carrying the recollection under its
 * `[Recall id]` header. See the package README for the model contract.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical
 */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CompactionEngine, CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { resolveConfig } from './config.ts'
import { MembraneBridge } from './membrane.ts'
import { AGENT_PARTICIPANT, openSessionRuntime, syncSessionMirror, syncToolDefinitions } from './mirror.ts'
import type { SessionRuntime } from './mirror.ts'
import { planFolds } from './applicator.ts'
import type { FoldOp } from './applicator.ts'
import type { AutobiographicalCompactionConfig, ResolvedAutobiographicalConfig } from './types.ts'

export type { AutobiographicalCompactionConfig, ResolvedAutobiographicalConfig } from './types.ts'
export { planFolds } from './applicator.ts'
export type { FoldOp } from './applicator.ts'
export { MembraneBridge } from './membrane.ts'

interface RuntimeEntry {
  runtime: SessionRuntime
  /** Serialized background compression chain; one strategy tick in flight per session. */
  tickChain: Promise<void>
  /** Live-stream bookkeeping: the next call's attempt number and unflushed text. */
  progress: { attempt: number; buffer: string }
}

/** Buffered progress text flushes at this size, or when the call ends. */
const PROGRESS_FLUSH_CHARS = 1000

/**
 * Default ceiling for the compile budget when the adapter reports a larger
 * window: the kv-stable controller folds to keep the live context under this
 * minus the response reserve. Models degrade well before their advertised
 * window, so the operating point stays at ~64k regardless of route.
 */
const DEFAULT_OPERATING_WINDOW_TOKENS = 65_536

/**
 * Compaction engine whose folding decisions come from the Connectome
 * autobiographical strategy. Load one per context as `ctx.compaction`.
 */
export class AutobiographicalCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'sessions']

  static Config: z<AutobiographicalCompactionConfig> = z.object({
    storeRoot: z.string(),
    contextWindowTokens: z.number().step(1).min(0),
    reserveTokens: z.number().step(1).min(0),
    recentWindowTokens: z.number().step(1).min(1),
    headWindowTokens: z.number().step(1).min(0),
    maxMessageTokens: z.number().step(1).min(1),
    targetChunkTokens: z.number().step(1).min(1),
    mergeThreshold: z.number().step(1).min(2),
    maxTokens: z.number().step(1).min(1),
    foldingStrategy: z.union([
      z.const('kv-stable'),
      z.const('flat-profile'),
      z.const('oldest-first'),
    ]),
    auto: z.boolean(),
  })

  /** Resolved and validated backend configuration. */
  readonly config: ResolvedAutobiographicalConfig

  private readonly runtimes = new Map<SessionId, Promise<RuntimeEntry>>()
  private compactionCounter = 0
  /** Whether the automatic step-boundary pass is currently registered. */
  private automaticFolding: boolean
  private disposeAutomaticFolding: (() => boolean) | undefined

  constructor(ctx: Context, config: AutobiographicalCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.automaticFolding = this.config.auto
    if (this.automaticFolding) this.registerAutomaticFolding()
    // Cleanup is unconditional: a run with `auto: false` still opens stores
    // through compactNow/compactIfNeeded, and a leaked chronicle lock wedges
    // the next opener of that session's archive.
    ctx.on('agent/disposed', ({ agent }) => {
      const opening = this.runtimes.get(agent.session.id)
      this.runtimes.delete(agent.session.id)
      if (opening !== undefined) {
        void opening.then((entry) => {
          entry.runtime.manager.close()
        }).catch(() => {})
      }
    })
  }

  /** Whether automatic step-boundary folding is currently active. */
  get isAutomaticFoldingEnabled(): boolean {
    return this.automaticFolding
  }

  /**
   * Turn automatic step-boundary folding on or off at runtime, without
   * unloading the backend. Disabling removes the folding listener, so the
   * engine stops forming memories on its own and the surface stops changing
   * between turns; explicit requests — `compactNow()` from `/compact`, and any
   * other caller of `compactIfNeeded()` — still fold. A pass already in flight
   * when this is called still lands its folds.
   * @param enabled - whether the step-boundary pass should run.
   * @returns the state in force after the call.
   */
  setAutomaticFolding(enabled: boolean): boolean {
    if (enabled === this.automaticFolding) return this.automaticFolding
    if (enabled) {
      this.registerAutomaticFolding()
    } else {
      this.disposeAutomaticFolding?.()
      this.disposeAutomaticFolding = undefined
    }
    // Set last: registration throws on an inactive fiber, and a throw must
    // leave the reported state matching the registration that actually exists.
    this.automaticFolding = enabled
    return this.automaticFolding
  }

  /**
   * Resolve the memory-formation route. Autobiographical memory is the agent
   * writing about its own history, so it always runs on the session's own
   * routed target; a different model would be a substitute voice (and a
   * second paid model route).
   */
  private summarizationRoute(agent: CompactionAgentContext): { provider: string; model: string } | undefined {
    const routed = agent.session.requestContext()
    if (routed !== undefined) return { provider: routed.provider, model: routed.model }
    if (agent.options.provider !== undefined && agent.options.provider.length > 0
      && agent.options.model !== undefined && agent.options.model.length > 0) {
      return { provider: agent.options.provider, model: agent.options.model }
    }
    return undefined
  }

  /** Open (once per session) the Chronicle-backed runtime under the session's store root. */
  private runtimeFor(agent: CompactionAgentContext): Promise<RuntimeEntry> {
    const session = agent.session
    const cached = this.runtimes.get(session.id)
    if (cached !== undefined) return cached
    const route = this.summarizationRoute(agent)
    if (route === undefined) {
      return Promise.reject(new Error(
        'compaction-autobiographical: no summarization route; the session has not routed a request yet',
      ))
    }
    const cwd = session.header.cwd
    const storePath = join(
      cwd === undefined ? resolve(this.config.storeRoot) : resolve(cwd, this.config.storeRoot),
      session.id,
    )
    // Per-session bookkeeping for the bridge's streamed text tap (see onText).
    // The attempt counter is seeded past every attempt the log already holds,
    // so a restarted runtime never reuses a row identity.
    const priorAttempts = session.events
      .filter(event => event.type === 'autobio/memory-progress')
      .map(event => event.data.attempt)
    const progress = {
      attempt: priorAttempts.length === 0 ? 1 : Math.max(...priorAttempts) + 1,
      buffer: '',
    }
    const opening = openSessionRuntime(
      storePath,
      this.config,
      new MembraneBridge({
        llm: this.ctx.llm,
        provider: route.provider,
        model: route.model,
        ...this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens },
        agentParticipant: AGENT_PARTICIPANT,
        warn: (message) => {
          // The library narrates its own quarantines to the console; match it
          // so a failed compression call is never only in the structured log.
          this.ctx.logger.warn(message)
          console.warn(`[compaction-autobiographical] ${message}`)
        },
        onText: (delta, done) => {
          // Live memory-formation text for the chat's per-call rows. A flush
          // appends one log-only event; bookkeeping must never kill the
          // compression call, so a session that closed mid-call swallows it.
          progress.buffer += delta
          if (!done && progress.buffer.length < PROGRESS_FLUSH_CHARS) return
          try {
            session.append('autobio/memory-progress', {
              attempt: progress.attempt,
              delta: progress.buffer,
              ...done ? { done: true } : {},
            })
          } catch {
            progress.buffer = ''
            if (done) progress.attempt += 1
            return
          }
          progress.buffer = ''
          if (done) progress.attempt += 1
        },
      }),
      route.model,
    ).then(runtime => ({ runtime, tickChain: Promise.resolve(), progress }))
    this.runtimes.set(session.id, opening)
    // A failed open (locked store, corrupt archive) must not poison the cache:
    // drop the rejected entry so the next pass retries.
    opening.catch(() => {
      if (this.runtimes.get(session.id) === opening) this.runtimes.delete(session.id)
    })
    return opening
  }

  /**
   * Operator-visible warning: the structured log and the console. The library
   * narrates its own quarantines to the console, and headless surfaces do not
   * print `ctx.logger` output, so a fold-path failure reported only to the
   * log would be invisible exactly where it matters.
   */
  private warn(message: string): void {
    this.ctx.logger.warn(message)
    console.warn(`[compaction-autobiographical] ${message}`)
  }

  /**
   * Run one serialized compression tick, reporting whether it formed memory.
   * Background kicks ignore the result; a synchronous catch-up awaits it. A
   * tick that changed the strategy's stats appends one `autobio/memory`
   * event so the chat can show memory formation as it happens.
   */
  private runTick(session: CompactionAgentContext['session'], entry: RuntimeEntry): Promise<boolean> {
    const tick: Promise<boolean> = entry.tickChain.then(async () => {
      const manager = entry.runtime.manager
      const before = JSON.stringify(entry.runtime.strategy.getStats())
      const known = new Set(manager.getSummariesInRange({}).map(summary => summary.id))
      await manager.tick()
      const stats = entry.runtime.strategy.getStats()
      if (JSON.stringify(stats) === before) return false
      const minted = manager.getSummariesInRange({}).filter(summary => !known.has(summary.id)).at(-1)
      session.append('autobio/memory', {
        ...stats,
        ...minted === undefined ? {} : {
          // The mint came from the call that just ended; its attempt was
          // already spent by the done flush.
          attempt: entry.progress.attempt - 1,
          memory: { id: minted.id, level: minted.level, content: minted.content, tokens: minted.tokens },
        },
      })
      return true
    })
    entry.tickChain = tick.then(() => undefined, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`autobiographical memory formation failed: ${message}`)
    })
    return tick.catch(() => false)
  }

  /** Commit the frontier and read its rendered layout; null when no layout fits. */
  private async tryPreview(
    entry: RuntimeEntry,
    budget: { maxTokens: number; reserveForResponse: number },
  ): Promise<ReturnType<SessionRuntime['manager']['previewContext']> | null> {
    await entry.runtime.manager.compile(budget)
    return entry.runtime.manager.previewContext(budget, undefined, { render: true })
  }

  /**
   * One folding pass: mirror new history, commit the strategy's frontier at
   * the current budget, then land the planned folds on the surface. Returns
   * the compaction bookkeeping when at least one fold landed, else null.
   */
  private async foldPass(
    agent: CompactionAgentContext,
    signal: AbortSignal,
    turn: number | null,
    step: number,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    const entry = await this.runtimeFor(agent)
    syncSessionMirror(entry.runtime, session)
    syncToolDefinitions(entry.runtime, session)
    // Opportunistic background progress; the catch-up below awaits its own.
    void this.runTick(session, entry)

    // Default operating point: fold toward ~64k rather than the model's full
    // window — models degrade long before their advertised context. A
    // configured `contextWindowTokens` overrides outright (also the lever for
    // evaluating folding against a small deliberate budget); without it (and
    // before the first routed request) the pass skips until a route is known.
    const routedWindow = session.requestContext()?.contextWindow
    const contextWindow = this.config.contextWindowTokens
      ?? (routedWindow === undefined ? undefined : Math.min(routedWindow, DEFAULT_OPERATING_WINDOW_TOKENS))
    if (contextWindow === undefined) return null
    const budget = { maxTokens: contextWindow, reserveForResponse: this.config.reserveTokens }

    // The picker can refuse in two ways — throw OverBudgetError, or answer a
    // preview whose diagnostics report no fitting layout. Either way the turn
    // waits: memory formation runs on the inference thread, one tick at a
    // time, until a layout fits or a tick forms no new memory (nothing left
    // to compress, so waiting longer cannot help).
    let lastError: string | null = null
    let preview: ReturnType<SessionRuntime['manager']['previewContext']> | null
    for (;;) {
      try {
        preview = await this.tryPreview(entry, budget)
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error)
        preview = null
      }
      if (preview !== null && preview.entries !== undefined) break
      if (signal.aborted) return null
      const progressed = await this.runTick(session, entry)
      if (!progressed) break
    }
    if (preview === null || preview.entries === undefined) {
      // Nothing foldable remains and still no layout fits; the turn proceeds
      // on the unchanged surface and the provider's overflow recovery reports
      // through the existing path.
      const detail = preview !== null && !preview.fits
        ? `${preview.finalTokens} tokens against a ${preview.budgetTokens}-token budget `
          + `(head ${preview.headTokens}, tail ${preview.tailTokens}, middle ${preview.middleTokens} `
          + `across ${preview.middleChunkCount} chunks, deepest level ${preview.deepestLevel}`
          + `${preview.exhausted ? ', picker exhausted' : ''})`
        : lastError ?? 'the strategy produced no preview'
      this.warn(`autobiographical frontier planning found no layout that fits: ${detail}; leaving the surface unchanged for this pass`)
      return null
    }
    signal.throwIfAborted()

    const ops = planFolds(session, entry.runtime, preview.entries)
    if (ops === null || ops.length === 0) return null
    return this.executeFolds(session, ops, turn, step)
  }

  /** Land the planned folds as one bracketed, metered transaction. */
  private executeFolds(
    session: Session,
    ops: readonly FoldOp[],
    turn: number | null,
    step: number,
  ): CompactionResult {
    // The caller guarantees at least one op, so the folded range is the first
    // op's start through the last op's end.
    const route = this.summarizationRoute({ session, options: {} })
    const provider = route?.provider ?? ''
    const model = route?.model ?? ''
    const compactionId = CompactionId(`autobio-${session.id}-${++this.compactionCounter}`)
    const startSeq = session.append('compaction/start', { compactionId, turn }).seq

    let summarySeq = startSeq
    let lastSummary: import('@deepseek-ai/dsh-llm').ContentBlock[] = []
    const allShadowed: number[] = []
    let shadowedTokenCount = 0
    let firstShadowed = 0
    let lastShadowed = 0

    for (const [opIndex, op] of ops.entries()) {
      const blocks: import('@deepseek-ai/dsh-llm').ContentBlock[] = [{ type: 'text', text: op.text }]
      const shadowedTokens = Math.ceil(op.text.length / 4)
      summarySeq = session.append('compaction/summary', {
        compactionId,
        summary: blocks,
        shadowedRange: { start: op.startSeq, end: op.endSeq },
        shadowedSeqs: [...op.shadowedSeqs],
        shadowedTokenCount: shadowedTokens,
        provider,
        model,
        ...this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens },
      }).seq
      session.append('assistant/message', {
        turn: turn ?? 0,
        step,
        message: createMessage({
          role: 'assistant',
          content: blocks,
          // The model source preserves voice provenance; the compactionId
          // rides along so the chat timeline can correlate this replacement
          // with its compaction lifecycle and render the fold marker.
          source: { kind: 'model', provider, model, compactionId },
        }),
      }, {
        surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq },
        sourceEventSeqs: [...op.shadowedSeqs],
      })
      lastSummary = blocks
      allShadowed.push(...op.shadowedSeqs)
      shadowedTokenCount += shadowedTokens
      if (opIndex === 0) firstShadowed = op.startSeq
      lastShadowed = op.endSeq
    }

    const endSeq = session.append('compaction/end', { compactionId, turn }).seq
    this.ctx.logger.info(
      `autobiographical compaction: folded ${ops.length} region(s), `
      + `shadowed ${allShadowed.length} surface nodes`,
    )
    return {
      compactionId,
      startSeq,
      summarySeq,
      endSeq,
      summary: lastSummary,
      shadowedRange: { start: firstShadowed, end: lastShadowed },
      shadowedSeqs: allShadowed,
      shadowedTokenCount,
    }
  }

  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    void trigger
    return this.foldPass(agent, signal, this.currentTurn(agent.session), 0)
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    void sourceCommandId
    return agent.runMaintenance(maintenanceSignal =>
      this.foldPass(agent, AbortSignal.any([signal, maintenanceSignal]), null, 0))
  }

  override compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    void start
    void end
    void agent
    void signal
    return Promise.reject(new ManualCompactionError(
      'summary',
      'compaction-autobiographical folds regions automatically as they age; '
      + 'explicit region compaction is not supported by this backend',
    ))
  }

  /** The session's latest started turn, for fold-node attribution outside a live step. */
  private currentTurn(session: Session): number | null {
    for (let index = session.events.length - 1; index >= 0; index--) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const event = session.events[index]!
      if (event.type === 'turn/start') return event.data.turn
    }
    return null
  }

  /**
   * Fold aged history at every step boundary, before request derivation. The
   * listener is registered once and removed when automatic folding is turned
   * off at runtime, so a disabled engine has no step-boundary presence at all.
   */
  private registerAutomaticFolding(): void {
    const { ctx } = this
    this.disposeAutomaticFolding = ctx.on('agent/pre-step', async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          await this.foldPass(agent, signal, turn, step)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          this.warn(`autobiographical folding failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })
  }
}

export default AutobiographicalCompactionEngine
