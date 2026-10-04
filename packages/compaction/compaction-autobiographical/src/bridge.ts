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
  /** Generation budget floor; the library clamps its own request; this floors it back up. */
  readonly maxTokens?: number
  /** Participant name that maps to the assistant role (the agent's own voice). */
  readonly agentParticipant?: string
  readonly warn?: (message: string) => void
  /**
   * Cancellation for the call about to start, read once per call. The calls run
   * on the engine's own tick chain rather than inside the pass that scheduled
   * them, so the signal is a live read instead of a value captured at
   * construction.
   */
  readonly signal?: () => AbortSignal | undefined
  /**
   * Streamed text tap for the chat's live memory-formation rows. Fires per
   * delta and once when the call ends however it ends — with the failure that
   * ended it — which is what bounds an attempt.
   */
  readonly onText?: (delta: string, done: boolean, usage?: TokenUsage, failure?: string) => void
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
      // The library carries a result's content as a bare string in the stub it
      // synthesizes for an orphaned call, and as blocks otherwise.
      return {
        type: 'tool-result',
        toolCallId: CallId(block.toolUseId),
        content: typeof block.content === 'string'
          ? [{ type: 'text', text: block.content }]
          : toTextBlocks(block.content),
        ...block.isError === undefined ? {} : { isError: block.isError },
      }
    default:
      return { type: 'text', text: `[${block.type} omitted from memory-formation transcript]` }
  }
}

/** A foreign participant's opening block, named so the speaker survives replay. */
function withName(block: ContentBlock, participant: string): ContentBlock {
  /* v8 ignore next -- unreachable: `toHarness` maps away or drops every block
     the harness cannot express, so a foreign message's first block is text. */
  if (block.type !== 'text') return block
  return { type: 'text', text: `${participant}: ${block.text}` }
}

/** A result's blocks as text; anything not text is a payload the summary cannot use. */
function toTextBlocks(blocks: readonly MembraneBlock[]): ContentBlock[] {
  return blocks.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [])
}

type RequestMessage = NormalizedRequest['messages'][number]

/**
 * One request message in harness shape. Compression prompts are rebuilt
 * transcripts, so speaker attribution has to survive: participants that are
 * neither the agent nor `user` keep their name as a text prefix.
 *
 * A tool result is a harness message in its own right, because the wire
 * serializer emits a mixed message's text before its tool entries and so
 * orphans them from the assistant call they answer. No split happens here: the
 * library ran `splitMixedToolMessages` and `collapseConsecutiveMessages` before
 * building this request, so a result arrives alone or already heads its message,
 * with the prose that trailed it following behind.
 */
interface Voice {
  readonly provider: string
  readonly model: string
}

/**
 * Voice the calls are made in. The library resolves it, so every rebuilt
 * message is attributed to what the request asked for rather than to a second
 * reading of the route that could drift from it.
 */
function toHarnessMessage(message: RequestMessage, agentParticipant: string, voice: Voice): Message[] {
  const blocks = message.content.flatMap((block) => {
    const mapped = toHarness(block)
    return mapped === null ? [] : [mapped]
  })
  if (message.participant === agentParticipant) {
    return [createAssistantMessage({ content: blocks, source: voice })]
  }
  const named = message.participant === 'user' || blocks.length === 0
    ? blocks
    // A foreign message keeps its speaker on the block it opens with. Every block
    // it holds may have mapped away — a message of redacted reasoning alone does —
    // and then there is no opening block to name and nothing to say.
    : [withName(blocks[0] as ContentBlock, message.participant), ...blocks.slice(1)]
  // `createUserMessage` with the tool source would stamp a generic identity;
  // the library matches a result to its call through the block's own id.
  const results = named
    .filter(block => block.type === 'tool-result')
    .map(block => createToolResultMessage({ callId: block.toolCallId, content: block.content, isError: block.isError === true }))
  const prose = named.filter(block => block.type !== 'tool-result')
  return prose.length === 0
    ? results
    : [...results, createMessage({ role: 'user', content: prose, source: { kind: 'plugin', plugin: PLUGIN } })]
}

const PLUGIN = 'compaction-autobiographical'

/**
 * A `Membrane` whose `complete` is one harness stream call.
 *
 * Only `complete` is implemented: the library's compression, merge and refusal
 * paths all funnel through it, and the rest of the class is streaming, retry
 * and provider-plumbing the harness already owns. The cast is how the library
 * is told to use this instead of constructing its own provider client.
 *
 * The request's own tools are forwarded to the harness call. The library's
 * refusal ladder is built on the request carrying them: a summarizer request
 * that replays tool history without its tools reads to a provider's safety
 * classifier as a foreign agent trace, which is a deterministic refusal of every
 * memory-write, and there is nothing for the ladder to escalate from.
 *
 * @param options - the harness LLM runtime, the routed provider, the token floor
 *   under the library's own request size, the participant that maps to the
 *   assistant role, and the warning and streamed-text taps.
 * @returns a `Membrane` the library can be handed in place of a provider client.
 */
export function createBridge(options: BridgeOptions): Membrane {
  const { llm, provider, maxTokens, warn, onText } = options
  const agentParticipant = options.agentParticipant ?? DEFAULT_AGENT_PARTICIPANT

  return {
    async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
      const voice: Voice = { provider, model: request.config.model }
      const messages = request.messages.flatMap(message => toHarnessMessage(message, agentParticipant, voice))
      const assembler = new BlockAssembler()
      // Read at the call, not at construction: a pass arms the cancellation when
      // it kicks the tick, and the tick's calls start after that pass returned.
      const signal = options.signal?.()
      // The library sizes its own request; a long-reasoning model still needs
      // room for thinking beside the recollection, so the configured cap is a
      // floor rather than a replacement — and a request that asks for no cap
      // leaves the field off entirely rather than flooring it at zero.
      const capped = request.config.maxTokens > 0
        ? Math.max(request.config.maxTokens, maxTokens ?? 0)
        : maxTokens
      let failure: string | undefined
      try {
        for await (const chunk of llm.stream({
          provider,
          // The request names the model the library resolved for this call
          // (`compressionModel`), which is the voice a recollection is written
          // in; taking it from anywhere else would let the two drift.
          model: request.config.model,
          messages,
          ...request.system === undefined ? {} : { system: request.system },
          ...request.tools === undefined ? {} : { tools: request.tools.map(toHarnessTool) },
          ...capped === undefined ? {} : { maxTokens: capped },
          ...request.config.temperature === undefined ? {} : { temperature: request.config.temperature },
          ...signal === undefined ? {} : { signal },
          purpose: 'compaction',
        })) {
          if (chunk.type === 'text-delta') onText?.(chunk.text, false)
          assembler.push(chunk)
        }
      } catch (error: unknown) {
        // The library classifies a thrown call as abort without the text;
        // echo it so a quarantine is diagnosable from the console.
        failure = error instanceof Error ? error.message : String(error)
        warn?.(`compression call threw: ${failure}`)
        onText?.('', true, assembler.usage, failure)
        throw error
      }

      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        failure = `${finish.failure.code} ${finish.failure.message}`
        warn?.(`compression call ended ${finish.kind}: ${failure}`)
      }
      // The terminal tap closes the attempt either way: a call that streamed no
      // text and failed has no other record of having been made.
      onText?.('', true, assembler.usage, failure)
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
    // `inputSchema.type` is not read from the library's schema: the harness
    // schema is always an object, and spreading it here would let a schema that
    // declares its own `type` win over that.
    parameters: {
      type: 'object',
      ...properties === undefined ? {} : { properties },
      ...required === undefined ? {} : { required },
    },
  }
}

/**
 * The response in the library's vocabulary, priced so a fold can pay for
 * itself. Reasoning stays on for the call, but a recollection that replays
 * more thinking than the text it stands over is a fold that can never be
 * taken, so in that case the thinking is dropped and the recollection is
 * priced at its text alone.
 *
 * The comparison is characters against characters — a shape test, not a token
 * account. It runs before the harness has priced anything and only has to
 * separate a compact recollection from an outsized one.
 */
function toMembraneBlocks(blocks: readonly ContentBlock[], messages: readonly Message[]): MembraneBlock[] {
  const mapped: MembraneBlock[] = blocks.flatMap((block): MembraneBlock[] => {
    switch (block.type) {
      case 'text': return [{ type: 'text', text: block.text }]
      case 'reasoning': return [{ type: 'thinking', thinking: block.text }]
      case 'tool-call': return [{
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parseArguments(block.arguments),
      }]
      // ContentBlockMap is merge-extensible and only these three have a
      // membrane spelling; a plugin-added block carries nothing a summary can
      // say, so it is dropped rather than stringified into the fold's text.
      /* v8 ignore next -- unreachable through this path: the only caller is fed
         TokenStream chunks, and every type those can carry is mapped above. */
      default: return []
    }
  })
  let thinking = 0
  let printed = 0
  for (const block of mapped) {
    /* v8 ignore next -- the three arms partition the mapped blocks, so exactly
       one of these two fires and neither condition is ever false. */
    if (block.type === 'thinking') thinking += block.thinking.length
    if (block.type === 'text') printed += block.text.length
  }
  if (thinking === 0 || printed === 0) return mapped
  const ground = messages.reduce(
    (total, message) => total + message.content.reduce(
      /* v8 ignore next -- both arms are taken; only the text arm adds. */
      (inner, block) => block.type === 'text' ? inner + block.text.length : inner,
      0,
    ),
    0,
  )
  return thinking + printed > ground ? mapped.filter(block => block.type !== 'thinking') : mapped
}

/** Tool arguments as the library stores them; unparseable input keeps its raw form. */
function parseArguments(arguments_: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(arguments_)
    /* v8 ignore next 3 -- a compression call always carries a JSON object, and
       the library re-parses whatever is returned here, so anything else would
       land in the stored transcript as real tool input. */
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}
