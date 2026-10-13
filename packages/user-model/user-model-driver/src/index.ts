/**
 * @module @deepseek-ai/dsh-user-model-driver
 *
 * Stall-driven continuation driver for the user-model capability: when an
 * armed session goes fully quiescent — agent idle, inbox empty, no live
 * background jobs — the driver generates the next user-side reply with the
 * user-model and queues it as a follow-up turn, so long-running work keeps
 * a conversational partner instead of stalling silently.
 *
 * The driver holds no selection state of its own: arming, disarming, and
 * the per-arming reply count are read from the durable session log through
 * `@deepseek-ai/dsh-user-model` folds, so a reload of this plugin over an
 * existing log resumes exactly where the log says. Automatic authority ends
 * durably when the user-model emits its completion marker, when the reply
 * budget is exhausted, when a turn fails, or when generation itself fails.
 */

import { FiberState } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  buildUserModelTranscript,
  callUserModel,
  countUserModelReplies,
  parseUserModelReply,
  readUserModelSelection,
  renderUserModelSystemPrompt,
} from '@deepseek-ai/dsh-user-model'
import type { UserModelDisarmReason, UserModelSelection } from '@deepseek-ai/dsh-user-model'

export const name = 'user-model-driver'
export const inject = ['agents', 'sessions', 'llm', 'jobs']

/** Validated driver tuning. */
export interface Config {
  /** Maximum user-model replies per arming before the driver disarms. Default 20. */
  maxReplies?: number
  /** Generation budget per reply. Default 4096. */
  maxTokens?: number
}

const DEFAULT_MAX_REPLIES = 20
const DEFAULT_MAX_TOKENS = 4096

/** Render one caught unknown for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Per-agent driver bookkeeping, keyed by the exact live lifecycle. */
interface DriverState {
  agent: Agent
  abort: AbortController | undefined
  needsCheckpoint: boolean
  pendingDisarm: UserModelDisarmReason | undefined
  requested: boolean
  scheduled: boolean
  run: Promise<void> | undefined
  stopping: boolean
}

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`user-model-driver: ${name} must be a positive integer, got ${String(value)}`)
  }
}

/**
 * @param ctx - composition context.
 * @param config - reply budget and generation limits; both default when omitted.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxReplies = config.maxReplies ?? DEFAULT_MAX_REPLIES
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  assertPositiveInteger('maxReplies', maxReplies)
  assertPositiveInteger('maxTokens', maxTokens)

  const states = new Map<Agent, DriverState>()

  function stateFor(agent: Agent): DriverState {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const state: DriverState = {
      agent,
      abort: undefined,
      needsCheckpoint: false,
      pendingDisarm: undefined,
      requested: false,
      scheduled: false,
      run: undefined,
      stopping: false,
    }
    states.set(agent, state)
    return state
  }

  /** Read only when the exact Agent remains live. */
  function live(state: DriverState): boolean {
    return ctx.agents.get(state.agent.id) === state.agent
  }

  /** Read only when the exact Agent remains live. */
  function currentSelection(state: DriverState): UserModelSelection | null {
    if (!live(state)) return null
    return readUserModelSelection(state.agent.session.events)
  }

  /** Whether this exact lifecycle is fully stalled with an armed user-model. */
  function readyToDrive(state: DriverState): boolean {
    return ctx.fiber.state === FiberState.ACTIVE
      && !state.stopping
      && live(state)
      && state.agent.status === 'idle'
      && state.agent.inbox.nextTurn.length === 0
      && state.agent.inbox.nextStep.length === 0
      && !ctx.jobs.list(state.agent).some(job => job.status === 'running' || job.status === 'stopping')
  }

  /**
   * End automatic authority durably, unless the log already moved on. The
   * `user-model/disarmed` append itself is deferred to the next drive pass:
   * listeners call `disarm` while a session event is still publishing, and
   * session append cannot reenter its own publish.
   */
  function disarm(state: DriverState, reason: UserModelDisarmReason): void {
    if (state.pendingDisarm !== undefined) return
    if (currentSelection(state) === null) return
    state.pendingDisarm = reason
    requestDrive(state)
  }

  /** Cancel one in-flight generation without touching durable state. */
  function abortGeneration(state: DriverState): void {
    state.abort?.abort()
    state.abort = undefined
  }

  /** Generate one reply at quiescence, then queue it as the next turn. */
  async function drive(state: DriverState): Promise<void> {
    const { agent } = state

    // A deferred disarm persists before anything else: even a busy session
    // must record the end of automatic authority durably.
    if (state.pendingDisarm !== undefined) {
      const reason = state.pendingDisarm
      state.pendingDisarm = undefined
      try {
        if (currentSelection(state) !== null) {
          agent.session.append('user-model/disarmed', { reason })
          state.needsCheckpoint = true
        }
      } catch (error: unknown) {
        ctx.logger.warn(`user-model-driver: could not disarm agent "${agent.id}": ${renderThrown(error)}`)
      }
    }

    if (!readyToDrive(state)) return

    if (state.needsCheckpoint) {
      state.needsCheckpoint = false
      try {
        await ctx.sessions.flush(agent.session)
      } catch (error: unknown) {
        ctx.logger.warn(`user-model-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state, 'generation-failed')
        return
      }
      // A mutation or ordinary prompt may have arrived while the checkpoint
      // was settling. Give it its own turn before generating a reply.
      if (!readyToDrive(state)) return
    }

    const selection = currentSelection(state)
    if (selection === null) return
    if (countUserModelReplies(agent.session.events) >= maxReplies) {
      disarm(state, 'replies-exhausted')
      return
    }

    const abort = new AbortController()
    state.abort = abort
    let raw: string
    try {
      raw = await callUserModel({
        llm: ctx.llm,
        session: agent.session,
        purpose: 'steer',
        provider: selection.provider,
        model: selection.model,
        system: renderUserModelSystemPrompt(selection),
        messages: buildUserModelTranscript(agent.session.deriveMessages(), selection),
        maxTokens,
        signal: abort.signal,
      })
    } catch (error: unknown) {
      if (abort.signal.aborted) return
      ctx.logger.warn(`user-model-driver: generation failed for agent "${agent.id}": ${renderThrown(error)}`)
      disarm(state, 'generation-failed')
      return
    } finally {
      if (state.abort === abort) state.abort = undefined
    }

    // The generation awaited; everything it depended on may have moved.
    if (!readyToDrive(state)) return
    const latest = currentSelection(state)
    if (latest === null
      || latest.provider !== selection.provider
      || latest.model !== selection.model
      || latest.prompt !== selection.prompt) return

    let reply: ReturnType<typeof parseUserModelReply>
    try {
      reply = parseUserModelReply(raw)
    } catch (error: unknown) {
      ctx.logger.warn(`user-model-driver: could not parse the user-model reply for agent "${agent.id}": ${renderThrown(error)}`)
      disarm(state, 'generation-failed')
      return
    }

    state.needsCheckpoint = true
    if (reply.done) {
      disarm(state, 'complete')
    }
    if (reply.text !== '') {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: reply.text }],
          source: { kind: 'user-model', provider: selection.provider, model: selection.model },
        }))
      } catch (error: unknown) {
        ctx.logger.warn(`user-model-driver: could not queue the reply for agent "${agent.id}": ${renderThrown(error)}`)
        disarm(state, 'generation-failed')
      }
    }
  }

  /**
   * Coalesce triggers onto one agent-local serialized driver. Triggers run
   * inside session-event publishes and agent-status emissions, where session
   * append is not reentrant; the run itself starts on a microtask so every
   * durable write happens outside the publishing stack.
   */
  function requestDrive(state: DriverState): void {
    if (state.stopping) return
    state.requested = true
    if (state.run !== undefined || state.scheduled) return
    state.scheduled = true
    queueMicrotask(() => {
      state.scheduled = false
      if (state.stopping || state.run !== undefined || !state.requested) return
      startRun(state)
    })
  }

  /** Start the serialized run loop for one agent. */
  function startRun(state: DriverState): void {
    let run: Promise<void>
    try {
      run = ctx.agents.withoutInitiator(async () => {
        while (state.requested && !state.stopping) {
          state.requested = false
          try {
            await drive(state)
          } catch (error: unknown) {
            ctx.logger.warn(`user-model-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`)
            disarm(state, 'generation-failed')
          }
        }
      })
    } catch (error: unknown) {
      ctx.logger.warn(`user-model-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state, 'generation-failed')
      return
    }
    state.run = run
    const retire = (): void => {
      state.run = undefined
      if (state.requested && !state.stopping) requestDrive(state)
    }
    void run.then(retire, (error: unknown) => {
      ctx.logger.warn(`user-model-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`)
      disarm(state, 'generation-failed')
      retire()
    })
  }

  ctx.effect(function* () {
    ctx.on('agent/created', ({ agent }) => { stateFor(agent) })
    ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })
    ctx.on('agent/session-start', ({ agent }) => {
      const state = stateFor(agent)
      abortGeneration(state)
      state.needsCheckpoint = false
    })
    ctx.on('agent/error', ({ agent }) => {
      const state = stateFor(agent)
      abortGeneration(state)
      disarm(state, 'turn-failed')
    })

    ctx.on('agent/status', ({ agent, status }) => {
      const state = stateFor(agent)
      if (status === 'idle') {
        requestDrive(state)
      } else {
        abortGeneration(state)
      }
    })
    ctx.on('agent/inbox/inserted', ({ agent }) => {
      // Competing input owns the next turn; an in-flight reply is stale.
      abortGeneration(stateFor(agent))
    })

    // A settled background job may be the last thing holding quiescence.
    const unsubscribeJobs = ctx.jobs.onJobsChanged((owner) => {
      if (owner === undefined) return
      requestDrive(stateFor(owner))
    })

    ctx.on('session/event', (session: Session, event) => {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      const state = stateFor(agent)
      switch (event.type) {
        case 'user-model/armed':
          // Arming an already-stalled session fires the first reply at once.
          requestDrive(state)
          return
        case 'user-model/disarmed':
          abortGeneration(state)
          state.needsCheckpoint = true
          requestDrive(state)
          return
        case 'turn/end':
          switch (event.data.reason.kind) {
            case 'completed':
              requestDrive(state)
              return
            case 'aborted':
            case 'error':
              // A failed or externally cancelled turn ends automatic
              // authority; the human or the failure owns the next word.
              disarm(state, 'turn-failed')
              return
            default:
              return
          }
        default:
          return
      }
    })

    yield async () => {
      const waits: Promise<void>[] = []
      for (const state of states.values()) {
        state.stopping = true
        abortGeneration(state)
        if (state.run !== undefined) waits.push(state.run)
      }
      unsubscribeJobs()
      await Promise.allSettled(waits)
      states.clear()
    }
  }, 'user-model-driver lifecycle')
}
