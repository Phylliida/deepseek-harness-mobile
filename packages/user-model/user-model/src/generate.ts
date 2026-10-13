/**
 * The shared auxiliary user-model call: log the exact request as a log-only
 * session event, stream the completion, and return the assembled text. Every
 * user-model generation — driver steering, question answering, approval
 * verdicts — passes through here so the model-visible boundary is recorded
 * once, in one shape.
 *
 * @module @deepseek-ai/dsh-user-model/generate
 */

import { BlockAssembler, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserModelRequestPurpose } from './types.ts'

/** One auxiliary user-model call. */
export interface UserModelCall {
  /** The LLM service to dispatch on. */
  readonly llm: Pick<LlmRuntime, 'stream'>
  /** The session the request is logged against. */
  readonly session: Session
  /** Which interaction the call serves; recorded on the request event. */
  readonly purpose: UserModelRequestPurpose
  /** Provider of the user-model route. */
  readonly provider: string
  /** Model of the user-model route. */
  readonly model: string
  /** Exact auxiliary system prompt (the persona prompt). */
  readonly system: string
  /** Exact auxiliary message list (role-flipped transcript plus framing). */
  readonly messages: readonly Message[]
  /** Output-token cap for the auxiliary call. */
  readonly maxTokens: number
  /** Optional cancellation. */
  readonly signal?: AbortSignal
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(purpose: UserModelRequestPurpose, finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error(`user-model: ${purpose} output reached maxTokens`)
    case 'tool-calls':
      return new Error(`user-model: ${purpose} model unexpectedly requested a tool`)
    default:
      return new Error(`user-model: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Run one auxiliary user-model call: append the log-only `user-model/request`
 * event with the exact system prompt and message list, then stream to a
 * finish. Tool-call output and non-stop finish reasons are failures.
 * @param call - the call description.
 * @returns the assembled reply text.
 */
export async function callUserModel(call: UserModelCall): Promise<string> {
  call.signal?.throwIfAborted()
  const messages = deepFreeze([...call.messages])
  const options: GenerateOptions = deepFreeze({
    provider: call.provider,
    model: call.model,
    messages,
    system: call.system,
    maxTokens: call.maxTokens,
    sessionId: call.session.id,
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  })
  call.session.append('user-model/request', {
    purpose: call.purpose,
    provider: call.provider,
    model: call.model,
    system: call.system,
    messages,
  })
  call.signal?.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of call.llm.stream(options)) {
    call.signal?.throwIfAborted()
    assembler.push(chunk)
  }
  call.signal?.throwIfAborted()
  const terminalError = finishError(call.purpose, assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error(`user-model: ${call.purpose} output must contain text only`)
  }
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
  if (text.trim().length === 0) throw new Error(`user-model: ${call.purpose} model produced no text`)
  return text
}
