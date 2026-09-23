// Autobio-memory conversation node: the autobiographical compaction backend
// appends one log-only `autobio/memory` event per memory-formation tick that
// changed the strategy's stats. All of them fold into a single status row
// (one constant business identity) that always reads the newest record, so
// the row drifts to the bottom of the loaded window as memory forms.

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Autobiographical memory-formation status row. */
    'autobio-memory': AutobioMemoryNode
  }
}

/** Latest strategy stats shown by the status row. */
export interface AutobioMemoryNode {
  readonly kind: 'autobio-memory'
  readonly seq: number
  readonly time: number
  readonly chunksTotal: number
  readonly chunksCompressed: number
  readonly l1: number
  readonly l2: number
  readonly l3: number
  readonly pendingMerges: number
  /** The recollection the newest tick minted, when it minted one. */
  readonly memory?: AutobioMemoryMint
}

/** The recollection a tick minted, disclosed by the row on click. */
export interface AutobioMemoryMint {
  readonly id: string
  readonly level: number
  readonly content: string
  readonly tokens: number
}

/** Structural mirror of the engine's event payload (kept loose like compactSource). */
interface AutobioMemoryEventData {
  readonly chunksTotal: number
  readonly chunksCompressed: number
  readonly l1: number
  readonly l2: number
  readonly l3: number
  readonly pendingMerges: number
  readonly memory?: AutobioMemoryMint
}

/** Read the tick payload, refusing records without numeric stats. */
function memoryOf(data: unknown): AutobioMemoryEventData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const fields = ['chunksTotal', 'chunksCompressed', 'l1', 'l2', 'l3', 'pendingMerges'] as const
  if (!fields.every(field => typeof record[field] === 'number')) return undefined
  const mint = mintOf(record.memory)
  return {
    chunksTotal: record.chunksTotal as number,
    chunksCompressed: record.chunksCompressed as number,
    l1: record.l1 as number,
    l2: record.l2 as number,
    l3: record.l3 as number,
    pendingMerges: record.pendingMerges as number,
    ...mint === undefined ? {} : { memory: mint },
  }
}

/** Read the minted recollection, dropping malformed ones to a stats-only row. */
function mintOf(memory: unknown): AutobioMemoryMint | undefined {
  if (typeof memory !== 'object' || memory === null) return undefined
  const record = memory as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.content !== 'string') return undefined
  if (typeof record.level !== 'number' || typeof record.tokens !== 'number') return undefined
  return memory as AutobioMemoryMint
}

type AutobioMemoryState = Record<string, never>

/** Memory-formation tick records collapsed into one updating status row Definition. */
export const autobioMemoryDefinition: ConversationNodeDefinition<AutobioMemoryState> = {
  kind: 'autobio-memory',
  target: 'chat',
  match: (event) => {
    // The event type is engine-owned; the loose comparison matches
    // compactSource's treatment of plugin-owned source fields.
    if ((event.type as string) !== 'autobio/memory') return null
    return memoryOf(event.data) === undefined ? null : { id: 'autobio-memory', role: 'update' }
  },
  start: () => ({}),
  update: context => context.state,
  buildViewNode: (context) => {
    // State carries nothing: the newest loaded tick record wins, whether it
    // arrived live, in the initial window, or inside a prepended page. Every
    // accepted match passed memoryOf, so the payload re-read cannot fail.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a context exists only once matched
    const match = context.matches[context.matches.length - 1]!
    // oxlint-disable-next-line typescript/no-non-null-assertion -- match() accepted this record through memoryOf
    const stats = memoryOf(match.event.data)!
    return chatNode(context, 'autobio-memory', match.event.seq, {
      kind: 'autobio-memory',
      seq: match.event.seq,
      time: match.event.time,
      ...stats,
    })
  },
}

/**
 * Register the memory-formation status row business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAutobioMemoryConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(autobioMemoryDefinition)
}
