/**
 * Fixtures shared by the engine's integration specs: a real transcript, a real
 * `ContextManager` over a seeded `LogStore`, and a recording summarizer.
 *
 * `tests/**` is exempt from coverage, so the helpers stay here rather than
 * duplicating a hundred lines of setup per suite.
 */

import { Context } from '@deepseek-ai/cordis'
import type { CompactionAgentContext, CompactionResult, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AutobiographicalCompactionEngine from '../src/index.ts'
import type { AutobiographicalCompactionConfig } from '../src/types.ts'

/**
 * Provide the token meter the engine prices a fold's shadowed nodes with on a
 * context that is about to gain an engine.
 *
 * Registered on the fixture's context — which is where the engine reads it — and
 * constructed on a context of its own, because a `TokenMeter` is a cordis service
 * and registering one is not what a fixture about folding is proving.
 *
 * @param ctx - the context the engine is constructed with.
 */
export function provideTokenMeter(ctx: Context): void {
  ctx.provide('tokenMeter', new TokenMeter(new Context()) as never)
}

/** Answers every compression call with one recollection-shaped block. */
export function summarizer(calls: GenerateOptions[]): { stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> } {
  return {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const text = `memory ${calls.length}: the agent asked and was answered.`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * A long transcript: enough exchanges that the strategy has something to fold.
 *
 * The route the backend budgets and speaks in comes from the log, not from the
 * caller: a session that never routed a model has no budget to fold to.
 */
export function transcript(id: string, turns: number, contextWindow: number | undefined = 100_000): Session {
  const session = Session.create(SessionId(id))
  session.append('request/context', { provider: 'test', model: 'test-model', contextWindow })
  for (let turn = 0; turn < turns; turn++) {
    session.append('turn/start', { turn })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: `ask ${turn} ${'x'.repeat(400)}` }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('assistant/message', {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn} ${'y'.repeat(400)}` }],
        source: { provider: 'test', model: 'test-model' },
      }),
      usage: { inputTokens: 1000, outputTokens: 100 },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/**
 * An engine and the context it registered into, with a recording summarizer.
 *
 * `into` lets a caller supply a context that already carries the services the
 * engine cooperates with — the agent registry emits the disposal edge, and the
 * engine only hears it if it registered into the context that dispatches it.
 * `llm` replaces the summarizer, for the cases where the *shape* of the answer
 * is what the test is about.
 */
export function build(
  turns: number,
  id: string,
  overrides: AutobiographicalCompactionConfig = {},
  into?: Context,
  llm?: { stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> },
  contextWindow: number | undefined = 100_000,
): {
  engine: AutobiographicalCompactionEngine
  calls: GenerateOptions[]
  session: Session
  agent: ManualCompactAgentContext
  ctx: Context
} {
  const session = transcript(id, turns, contextWindow)
  const { engine, calls, agent, ctx } = reopen(session, overrides, into, llm)
  return { engine, calls, session, agent, ctx }
}

/**
 * A fresh engine over a session that already exists: the second process of a
 * reopen, which shares nothing with the first but the log. The recording
 * summarizer is the assertion — a reopen that has to ask the model for anything
 * shows up in `calls`.
 */
export function reopen(
  session: Session,
  overrides: AutobiographicalCompactionConfig = {},
  into?: Context,
  llm?: { stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> },
): {
  engine: AutobiographicalCompactionEngine
  calls: GenerateOptions[]
  agent: ManualCompactAgentContext
  ctx: Context
} {
  const calls: GenerateOptions[] = []
  const ctx = into ?? new Context()
  ctx.provide('llm', (llm ?? summarizer(calls)) as never)
  // The engine prices a fold's shadowed nodes with this meter, so a fixture
  // without one could not plan a fold at all.
  provideTokenMeter(ctx)
  const engine = new AutobiographicalCompactionEngine(ctx, {
    operatingWindowTokens: 700,
    reserveTokens: 128,
    auto: false,
    // The strategy only cuts a chunk out of history it considers *aged*, and the
    // default recent window (30k tokens) is larger than this fixture, so nothing
    // would ever be compressible. A test transcript is short by construction.
    strategy: { recentWindowTokens: 0 },
    ...overrides,
  })
  const agent: ManualCompactAgentContext = {
    session,
    options: { provider: 'test', model: 'test-model' },
    // The loop hands the engine a claim so manual work cannot race a step; a spec
    // driving the manual entry point stands in for it.
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => task(new AbortController().signal),
  }
  return { engine, calls, agent, ctx }
}

/**
 * Drive passes until two in a row leave the log alone. Memory formation is
 * background work: a pass compiles, kicks the tick that mints a recollection,
 * and plans against the frontier the *previous* pass committed, so the fold that
 * replaces a recollection lands one pass after the recollection does. A single
 * pass that folds nothing means only that the tick has not caught up yet.
 */
export async function settle(
  engine: AutobiographicalCompactionEngine,
  agent: CompactionAgentContext,
  pass: PassFn = (context, signal) => engine.compactIfNeeded(context, 'pressure', signal),
): Promise<{ readonly result: CompactionResult | null; readonly folds: readonly FoldReport[] }> {
  let result: CompactionResult | null = null
  let previous = -1
  const signal = new AbortController().signal
  for (let passes = 1; passes <= 8; passes++) {
    const landed = await pass(agent, signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    if (landed !== null) result = landed
    // The tick appends after the pass returns, so the log has only settled once
    // a whole pass ends with its length unchanged.
    if (agent.session.events.length === previous) return { result, folds: summaries(agent.session) }
    previous = agent.session.events.length
  }
  throw new Error('the engine never stopped folding')
}

/**
 * The context an engine registered into, for the specs that have to emit on it.
 *
 * `Service.ctx` is protected: a subclass may read it, a fixture may not. The
 * engine's own listeners are keyed on the context it was constructed with, so a
 * spec that wants to reach them has to hold the same object.
 */
export function contextOf(engine: AutobiographicalCompactionEngine): Context {
  return (engine as unknown as { ctx: Context }).ctx
}

/** How `settle` drives the engine — either entry point reaches the same pass. */
export type PassFn = (
  agent: CompactionAgentContext,
  signal: AbortSignal,
) => Promise<CompactionResult | null>

/** One fold's identity and the log seqs it replaced. */
export type FoldReport = { readonly compactionId: string; readonly shadowedSeqs: readonly number[] }

/** Every `compaction/summary` in the log, in order. */
export function summaries(session: Session): readonly FoldReport[] {
  return session.events.flatMap(event => event.type === 'compaction/summary' ? [event.data] : [])
}
