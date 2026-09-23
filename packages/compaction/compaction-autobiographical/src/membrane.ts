/**
 * Bridge from the context-manager's membrane `complete()` to `ctx.llm.stream()`:
 * memory-formation calls ride the harness LLM capability so credentials,
 * routing, retry, and usage accounting stay with the harness adapters.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/membrane
 */

import { BlockAssembler, CallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as MembraneBlock, NormalizedRequest } from '@animalabs/membrane'

/** Route and voice the bridge binds compression calls to. */
export interface MembraneBridgeOptions {
  llm: LlmRuntime
  provider: string
  model: string
  maxTokens?: number
  /** Participant name that maps to the assistant role (the agent's own voice). */
  agentParticipant: string
  /** Diagnostic sink for failed compression calls; defaults to console.warn. */
  warn?: (message: string) => void
  /**
   * Text-delta tap for the chat's live memory-formation row: the bridge
   * reports each streamed text delta and one final zero-length delta
   * (`done: true`) when the call ends, however it ends. Call boundaries are
   * exactly the done flushes; the engine owns attempt numbering.
   */
  onText?: (delta: string, done: boolean) => void
}

/**
 * Map one membrane content block to the harness block vocabulary. Blocks the
 * harness cannot represent downstream (images, documents, audio) degrade to a
 * loud text placeholder: the bridge serves summarization prompts, where a
 * placeholder preserves the fact of an attachment without the payload.
 */
function toHarnessBlock(block: MembraneBlock): import('@deepseek-ai/dsh-llm').ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return { type: 'reasoning', text: block.thinking }
    case 'tool_use':
      return { type: 'tool-call', id: CallId(block.id), name: block.name, arguments: JSON.stringify(block.input) }
    case 'tool_result':
      return {
        type: 'tool-result',
        toolCallId: CallId(block.toolUseId),
        content: [{
          type: 'text',
          text: typeof block.content === 'string'
            ? block.content
            : block.content
              .filter((b): b is Extract<MembraneBlock, { type: 'text' }> => b.type === 'text')
              .map(b => b.text)
              .join('\n'),
        }],
        ...block.isError === undefined ? {} : { isError: block.isError },
      }
    case 'redacted_thinking':
      return null
    default:
      return { type: 'text', text: `[${block.type} omitted from memory-formation transcript]` }
  }
}

/**
 * One harness `llm/stream` call shaped as membrane's `complete()`. Only the
 * members the context-manager's compression paths consume are honored:
 * `messages`, `system`, and `config.maxTokens`. Participants other than the
 * agent and `user` keep their name as a text prefix so the summarizer's
 * reconstructed transcript preserves speaker attribution.
 */
export class MembraneBridge {
  private readonly llm: LlmRuntime
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private readonly agentParticipant: string
  private readonly warn: (message: string) => void
  private readonly onText: ((delta: string, done: boolean) => void) | undefined

  constructor(options: MembraneBridgeOptions) {
    this.llm = options.llm
    this.provider = options.provider
    this.model = options.model
    this.maxTokens = options.maxTokens
    this.agentParticipant = options.agentParticipant
    this.warn = options.warn ?? ((message: string) => {
      console.warn(`[compaction-autobiographical] ${message}`)
    })
    this.onText = options.onText
  }

  /** Run one non-streaming completion; the response shape matches membrane's contract. */
  async complete(request: NormalizedRequest): Promise<{
    content: MembraneBlock[]
    rawAssistantText: string
    toolCalls: never[]
    toolResults: never[]
    stopReason: string
    usage: { inputTokens: number; outputTokens: number }
    details: Record<string, never>
    raw: Record<string, never>
  }> {
    const mapped: Message[] = request.messages.map((message) => {
      const role = message.participant === this.agentParticipant ? 'assistant' : 'user'
      const named = message.participant !== 'user' && role === 'user'
      const blocks = message.content
        .map((block, index) => {
          const mapped = toHarnessBlock(block)
          if (mapped === null) return null
          if (named && index === 0 && mapped.type === 'text') {
            return { type: 'text', text: `${message.participant}: ${mapped.text}` } as const
          }
          return mapped
        })
        .filter(block => block !== null)
      return createMessage({
        role,
        content: blocks,
        source: role === 'assistant'
          ? { kind: 'model', provider: this.provider, model: this.model }
          : { kind: 'plugin', plugin: 'compaction-autobiographical' },
      })
    })

    // The CM transcript packs text and tool results into one message, but the
    // DeepSeek wire serializer emits a mixed user message's text BEFORE its
    // role:'tool' entries — orphaning them from the assistant tool_calls, and
    // the provider rejects the request. Split so every tool result rides its
    // own message, restoring the serializer's documented invariant.
    const messages: Message[] = mapped.flatMap((message) => {
      const results = message.content.filter(block => block.type === 'tool-result')
      if (results.length === 0 || results.length === message.content.length) return [message]
      return [
        ...results.map(result => createMessage({ role: message.role, content: [result], source: message.source })),
        createMessage({
          role: message.role,
          content: message.content.filter(block => block.type !== 'tool-result'),
          source: message.source,
        }),
      ]
    })

    const assembler = new BlockAssembler()
    // The configured cap pins the generation budget: the library clamps the
    // strategy's request down to it (compressionMaxTokens), and the bridge
    // floors the request up to it — a long-reasoning model needs room for
    // thinking alongside the recollection, which the strategy's own size
    // (16k floor) does not leave.
    const maxTokens = request.config.maxTokens > 0
      ? Math.max(request.config.maxTokens, this.maxTokens ?? 0)
      : this.maxTokens
    try {
      for await (const chunk of this.llm.stream({
        provider: this.provider,
        model: this.model,
        messages,
        ...request.system === undefined ? {} : { system: request.system },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...request.config.temperature === undefined ? {} : { temperature: request.config.temperature },
        purpose: 'compaction',
      })) {
        if (chunk.type === 'text-delta') this.onText?.(chunk.text, false)
        assembler.push(chunk)
      }
    } catch (error: unknown) {
      // The strategy classifies a thrown call as `abort` without the error
      // text; echo it so quarantines are diagnosable from the console.
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`compression call threw: ${message}`)
      throw error
    } finally {
      this.onText?.('', true)
    }

    const blocks = assembler.blocks()
    const content: MembraneBlock[] = []
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'text', text: block.text })
          break
        case 'reasoning':
          content.push({ type: 'thinking', thinking: block.text })
          break
        case 'tool-call': {
          let input: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(block.arguments)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>
            }
          } catch {
            content.push({
              type: 'tool_use', id: block.id, name: block.name, input, unparseableInput: block.arguments,
            })
            continue
          }
          content.push({ type: 'tool_use', id: block.id, name: block.name, input })
          break
        }
        default:
          break
      }
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      this.warn(`compression call ended ${finish.kind}: ${finish.failure.code} ${finish.failure.message}`)
    }
    const stopReason = finish.kind === 'stop' ? 'end_turn'
      : finish.kind === 'max-tokens' ? 'max_tokens'
        : finish.kind === 'tool-calls' ? 'tool_use'
          : 'abort'
    const usage = assembler.usage
    let outputTokens = usage?.outputTokens ?? 0
    // Reasoning stays on for the call — the model thinks as usual — but the
    // library prices a fold at the response's full outputTokens and replays
    // the stored thinking with it. A fold whose thinking + text costs more
    // than the source span can never pay for itself, so hand the library a
    // thinking-free response in that case: the fold prices at its text alone.
    const thinkingChars = content.reduce(
      (total, block) => block.type === 'thinking' ? total + block.thinking.length : total,
      0,
    )
    if (thinkingChars > 0 && content.some(block => block.type === 'text')) {
      const textChars = content.reduce(
        (total, block) => block.type === 'text' ? total + block.text.length : total,
        0,
      )
      const sourceChars = messages.reduce(
        (total, message) => total + message.content.reduce(
          (inner, block) => inner
            + (block.type === 'text' ? block.text.length : 0)
            + (block.type === 'tool-call' ? block.arguments.length : 0),
          0,
        ),
        0,
      )
      if (thinkingChars + textChars > sourceChars) {
        const stored = content.filter(block => block.type !== 'thinking')
        outputTokens = usage?.outputTokens !== undefined && usage.reasoningTokens !== undefined
          ? usage.outputTokens - usage.reasoningTokens
          : Math.ceil(textChars / 4)
        return {
          content: stored,
          rawAssistantText: stored
            .filter((block): block is Extract<MembraneBlock, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join(''),
          toolCalls: [],
          toolResults: [],
          stopReason,
          usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens },
          details: {},
          raw: {},
        }
      }
    }
    return {
      content,
      rawAssistantText: content
        .filter((block): block is Extract<MembraneBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join(''),
      toolCalls: [],
      toolResults: [],
      stopReason,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens,
      },
      details: {},
      raw: {},
    }
  }
}
