/**
 * Session mirror: replays a harness session's append-origin surface events
 * into a per-session Connectome `ContextManager`, so the autobiographical
 * strategy plans folds over the same history the harness logged. Fold
 * replacement nodes are the strategy's own output and are never mirrored back.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/mirror
 */

import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager'
import type { MessageId, StoredMessage } from '@animalabs/context-manager'
import type { ContentBlock as MembraneBlock, ToolParameter } from '@animalabs/membrane'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MembraneBridge } from './membrane.ts'
import type { ResolvedAutobiographicalConfig } from './types.ts'

/** Participant name mirrored assistant turns and written recollections share. */
export const AGENT_PARTICIPANT = 'assistant'

/** One open ContextManager plus the mirror's replay watermark. */
export interface SessionRuntime {
  readonly manager: ContextManager
  readonly strategy: AutobiographicalStrategy
  /** Highest session-log seq the mirror has consumed (mirrored or skipped). */
  watermark: number
}

/** Map one harness content block into the membrane vocabulary the mirror stores. */
function toMembraneBlock(block: ContentBlock): MembraneBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'thinking', thinking: block.text }
    case 'tool-call': {
      let input: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(block.arguments)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        // Unparseable arguments keep an empty input; the raw string is not
        // load-bearing for chunking or memory formation.
      }
      return { type: 'tool_use', id: block.id, name: block.name, input }
    }
    case 'tool-result':
      return {
        type: 'tool_result',
        toolUseId: block.toolCallId,
        content: block.content
          .filter((nested): nested is Extract<ContentBlock, { type: 'text' }> => nested.type === 'text')
          .map(nested => nested.text)
          .join('\n'),
        ...block.isError === undefined ? {} : { isError: block.isError },
      }
    default:
      return { type: 'text', text: `[${block.type} omitted from memory mirror]` }
  }
}

/** Convert one append-origin surface event into mirror blocks, or null when it carries none. */
function mirrorContent(event: SessionEvent): { participant: string; content: MembraneBlock[] } | null {
  if (!isAppendSurfaceEvent(event)) return null
  switch (event.type) {
    case 'user/message':
      return {
        participant: 'user',
        content: event.data.content.map(toMembraneBlock).filter(block => block !== null),
      }
    case 'assistant/message':
      return {
        participant: AGENT_PARTICIPANT,
        content: event.data.message.content.map(toMembraneBlock).filter(block => block !== null),
      }
    case 'tool/result':
      return {
        participant: 'user',
        content: event.data.message.content.map(toMembraneBlock).filter(block => block !== null),
      }
  }
}

/**
 * Open (or reopen) the per-session runtime: a Chronicle-backed ContextManager
 * running the autobiographical strategy, plus the replay watermark recovered
 * from the newest mirrored message's stamped seq.
 */
export async function openSessionRuntime(
  storePath: string,
  config: ResolvedAutobiographicalConfig,
  bridge: MembraneBridge,
  compressionModel: string,
): Promise<SessionRuntime> {
  // Mirrors connectome-host's buildFrameworkStrategy (resolveConfig carries
  // the host-level window defaults: 4k head, 30k recent, 10k message cap):
  // the session's own model
  // as the memory voice (else the strategy loudly refuses to form memories
  // with a substitute model), adaptive resolution on, and every tunable
  // passed through only when configured. Differences are structural to the
  // harness integration: ticks are driven at step boundaries rather than on
  // every mirrored message, and recollections are authored under the
  // mirrored-history participant name.
  const strategy = new AutobiographicalStrategy({
    headWindowTokens: config.headWindowTokens,
    recentWindowTokens: config.recentWindowTokens,
    compressionModel,
    ...config.maxTokens === undefined ? {} : { compressionMaxTokens: config.maxTokens },
    autoTickOnNewMessage: false,
    maxMessageTokens: config.maxMessageTokens,
    adaptiveResolution: true,
    summaryParticipant: AGENT_PARTICIPANT,
    ...config.targetChunkTokens === undefined ? {} : { targetChunkTokens: config.targetChunkTokens },
    ...config.mergeThreshold === undefined ? {} : { mergeThreshold: config.mergeThreshold },
    foldingStrategy: config.foldingStrategy,
  })
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: bridge as unknown as import('@animalabs/membrane').Membrane,
    tokenEstimator: (text: string) => Math.ceil(text.length / 4),
  })

  // -1 rather than 0: seq 0 is a real event and must mirror on a fresh store.
  let watermark = -1
  const count = manager.getMessageCount()
  if (count > 0) {
    const window = manager.getMessageWindow(count - 1, 1)
    const last: StoredMessage | undefined = window.messages[0]
    const stamped = last?.metadata?.['dshSeq']
    if (typeof stamped === 'number' && Number.isSafeInteger(stamped)) watermark = stamped
  }
  return { manager, strategy, watermark }
}

/**
 * Replay every session event past the watermark into the mirror and advance
 * the watermark to the log's tip. Non-surface and replacement events advance
 * the watermark without producing mirror messages.
 * @returns the number of events consumed (mirrored or skipped).
 */
export function syncSessionMirror(runtime: SessionRuntime, session: Session): number {
  const events = session.events
  let consumed = 0
  for (const event of events) {
    if (event.seq <= runtime.watermark) continue
    const mapped = mirrorContent(event)
    if (mapped !== null && mapped.content.length > 0) {
      runtime.manager.addMessage(mapped.participant, mapped.content, { dshSeq: event.seq })
    }
    runtime.watermark = event.seq
    consumed++
  }
  return consumed
}

/**
 * Resolve the session-log seq a mirrored message carries. The stamp is
 * written by {@link syncSessionMirror}; an unstamped message (e.g. a
 * strategy-authored marker) has no seq.
 */
export function messageSeq(runtime: SessionRuntime, messageId: MessageId): number | undefined {
  const message = runtime.manager.getMessage(messageId)
  const stamped = message?.metadata?.['dshSeq']
  return typeof stamped === 'number' && Number.isSafeInteger(stamped) ? stamped : undefined
}

/**
 * Push the session's assembled tool schemas into the archive. The strategy
 * defers compressing any chunk containing tool blocks until definitions are
 * present (a tools-less replay of a tool transcript trips provider refusal
 * classifiers), so a session that never pushed them would never fold.
 */
export function syncToolDefinitions(runtime: SessionRuntime, session: Session): void {
  const tools = session.requestHeader()?.tools
  if (tools === undefined) return
  runtime.manager.setToolDefinitions(tools.map((tool) => {
    // Both sides are JSON-Schema-shaped; the membrane type just narrows the
    // fields it reads when rendering the compression prompt.
    const parameters = tool.parameters as {
      properties?: Record<string, ToolParameter>
      required?: string[]
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object' as const,
        ...parameters.properties === undefined ? {} : { properties: parameters.properties },
        ...parameters.required === undefined ? {} : { required: parameters.required },
      },
    }
  }))
}
