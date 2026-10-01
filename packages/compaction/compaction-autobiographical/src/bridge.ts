/**
 * The context-manager's compression calls, routed through `ctx.llm.stream()`.
 *
 * A fold is a model call, and it has to ride the harness LLM capability so
 * credentials, routing, retry and usage accounting stay with the harness
 * adapters rather than a second provider client inside the library.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/bridge
 */

import { BlockAssembler, CallId, createAssistantMessage, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as MembraneBlock, Membrane, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane'

/** What the library hands the bridge, plus the harness services the call needs. */
export interface BridgeOptions {
  readonly llm: LlmRuntime
  readonly provider: string
  readonly model: string
  /** Generation budget floor; the library clamps its own request; this floors it back up. */
  readonly maxTokens?: number
  /** Participant name that maps to the assistant role (the agent's own voice). */
  readonly agentParticipant?: string
  readonly warn?: (message: string) => void
  /**
   * Streamed text tap for the chat's live memory-formation rows. Fires per
   * delta and once with `done: true` when the call ends however it ends, which
   * is what bounds an attempt.
   */
  readonly onText?: (delta: string, done: boolean, usage?: TokenUsage) => void
}

const DEFAULT_AGENT_PARTICIPANT = 'assistant'

/**
 * The library's block vocabulary in the harness's. Blocks the harness cannot
 * carry downstream — images, documents, audio — degrade to a loud placeholder:
 * these calls reconstruct a transcript to summarize, where `[image]` preserves
 * the fact of an attachment without shipping the payload back to a model that
 * is only being asked to describe what happened.
 */
function toHarness(block: MembraneBlock): ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return { type: 'reasoning', text: block.thinking }
    case 'redacted_thinking':
      // Opaque by construction; replaying the placeholder would be noise.
      return null
    case 'tool_use':
      return { type: 'tool-call', id: CallId(block.id), name: block.name, arguments: JSON.stringify(block.input) }
    case 'tool_result':
      return {
        type: 'tool-result',
        toolCallId: CallId(block.toolUseId),
        content: typeof block.content === 'string'
          ? [{ type: 'text', text: block.content }]
          : block.content.flatMap(b => b.type === 'text' ? [{ type: 'text' as const, text: b.text }] : []),
        ...block.isError === undefined ? {} : { isError: block.isError },
      }
    default:
      return { type: 'text', text: `[${block.type} omitted from memory-formation transcript]` }
  }
}

type RequestMessage = NormalizedRequest['messages'][number]

/**
 * One request message in harness shape. Compression prompts are rebuilt
 * transcripts, so speaker attribution has to survive: participants that are
 * neither the agent nor `user` keep their name as a text prefix.
 */
function toHarnessMessage(message: RequestMessage, agentParticipant: string, route: Route): Message[] {
  const blocks = message.content.flatMap((block) => {
    const mapped = toHarness(block)
    return mapped === null ? [] : [mapped]
  })
  if (message.participant === agentParticipant) {
    return [createAssistantMessage({ content: blocks, source: route })]
  }
  const named = message.participant === 'user'
    ? blocks
    : blocks.map((block, index) => index === 0 && block.type === 'text'
      ? { type: 'text' as const, text: `${message.participant}: ${block.text}` }
      : block)
  // Tool results are messages in their own right — the wire serializer emits a
  // mixed message's text before its tool entries, orphaning them from the
  // assistant call they answer. Split here so every result rides alone.
  const results = named.filter(block => block.type === 'tool-result')
  if (results.length === 0) {
    return [createMessage({ role: 'user', content: named, source: { kind: 'plugin', plugin: PLUGIN } })]
  }
  const rest = named.filter(block => block.type !== 'tool-result')
  return [
    // `createUserMessage` with the tool source would stamp a generic identity;
    // the library matches a result to its call through the block's own id.
    ...results.map(block => createToolResultMessage({
      callId: block.toolCallId,
      content: block.content,
      isError: block.isError === true,
    })),
    ...rest.length === 0
      ? []
      : [createMessage({ role: 'user', content: rest, source: { kind: 'plugin', plugin: PLUGIN } })],
  ]
}

/** Voice the calls are made in; every rebuilt message is attributed to it. */
interface Route {
  readonly provider: string
  readonly model: string
}

const PLUGIN = 'compaction-autobiographical'

/**
 * A `Membrane` whose `complete` is one harness stream call.
 *
 * Only `complete` is implemented: the library's compression, merge and refusal
 * paths all funnel through it, and the rest of the class is streaming, retry
 * and provider-plumbing the harness already owns. The cast is how the library
 * is told to use this instead of constructing its own provider client.
 */
export function createBridge(options: BridgeOptions): Membrane {
  const { llm, provider, model, maxTokens, warn, onText } = options
  const agentParticipant = options.agentParticipant ?? DEFAULT_AGENT_PARTICIPANT
  const route: Route = { provider, model }

  return {
    async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
      const messages = request.messages.flatMap(message => toHarnessMessage(message, agentParticipant, route))
      const assembler = new BlockAssembler()
      // The library sizes its own request; a long-reasoning model still needs
      // room for thinking beside the recollection, so the configured cap is a
      // floor rather than a replacement.
      const capped = request.config.maxTokens > 0
        ? Math.max(request.config.maxTokens, maxTokens ?? 0)
        : maxTokens
      try {
        for await (const chunk of llm.stream({
          provider,
          model,
          messages,
          ...request.system === undefined ? {} : { system: request.system },
          ...request.tools === undefined ? {} : { tools: request.tools.map(toHarnessTool) },
          ...capped === undefined ? {} : { maxTokens: capped },
          ...request.config.temperature === undefined ? {} : { temperature: request.config.temperature },
          purpose: 'compaction',
        })) {
          if (chunk.type === 'text-delta') onText?.(chunk.text, false)
          assembler.push(chunk)
        }
      } catch (error: unknown) {
        // The library classifies a thrown call as abort without the text;
        // echo it so a quarantine is diagnosable from the console.
        warn?.(`compression call threw: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      } finally {
        onText?.('', true, assembler.usage)
      }

      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        warn?.(`compression call ended ${finish.kind}: ${finish.failure.code} ${finish.failure.message}`)
      }
      const content = toMembraneBlocks(assembler.blocks(), messages)
      const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      return {
        content,
        rawAssistantText: text,
        toolCalls: [],
        toolResults: [],
        stopReason: finish.kind === 'stop' ? 'end_turn'
          : finish.kind === 'max-tokens' ? 'max_tokens'
            : finish.kind === 'tool-calls' ? 'tool_use'
              : 'abort',
        usage: {
          inputTokens: assembler.usage?.inputTokens ?? 0,
          outputTokens: assembler.usage?.outputTokens ?? 0,
        },
        details: {},
        raw: {},
      } as unknown as NormalizedResponse
    },
  } as unknown as Membrane
}

/**
 * The agent's live tools, declared on the compression request.
 *
 * The library builds this list itself (`tools: ctx.tools`, populated by
 * `setToolDefinitions`) and a summarizer request that replays tool history
 * *without* them reads to a provider's safety classifier as a foreign agent
 * trace, which is a deterministic refusal of every memory-write. Dropping them
 * here would leave the library's whole refusal ladder — the no-tools sentence,
 * the prose retry, the tools-less escalation — with nothing to escalate from.
 */
function toHarnessTool(tool: NonNullable<NormalizedRequest['tools']>[number]): ToolSchema {
  const { properties, required } = tool.inputSchema
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      ...properties === undefined ? {} : { properties },
      ...required === undefined ? {} : { required },
    },
  }
}

/**
 * The response in the library's vocabulary, priced so a fold can pay for
 * itself. Reasoning stays on for the call, but the library charges a fold its
 * response's full output tokens and then replays the stored thinking with
 * them; a recollection whose thinking costs more than the span it replaces is
 * a fold that can never be taken, so in that case the thinking is dropped and
 * the response is priced at its text alone.
 */
function toMembraneBlocks(blocks: readonly ContentBlock[], messages: readonly Message[]): MembraneBlock[] {
  const mapped: MembraneBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        mapped.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        mapped.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        mapped.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: parseArguments(block.arguments),
        })
        break
      }
      default:
        break
    }
  }
  const thinking = mapped.reduce((total, block) => block.type === 'thinking' ? total + block.thinking.length : total, 0)
  if (thinking === 0 || !mapped.some(block => block.type === 'text')) return mapped
  const text = mapped.reduce((total, block) => block.type === 'text' ? total + block.text.length : total, 0)
  const source = messages.reduce(
    (total, message) => total + message.content.reduce((inner, block) => inner
      + (block.type === 'text' ? block.text.length : 0)
      + (block.type === 'tool-call' ? block.arguments.length : 0), 0),
    0,
  )
  return thinking + text > source ? mapped.filter(block => block.type !== 'thinking') : mapped
}

/** Tool arguments as the library stores them; unparseable input keeps its raw form. */
function parseArguments(arguments_: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(arguments_)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
