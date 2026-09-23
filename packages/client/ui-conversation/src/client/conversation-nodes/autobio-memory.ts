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
  /** Live text of an in-flight memory-formation call, while one streams. */
  readonly streaming?: string
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
  readonly attempt?: number
  readonly memory?: AutobioMemoryMint
}

/** Structural mirror of the engine's progress payload. */
interface AutobioMemoryProgressData {
  readonly attempt: number
  readonly delta: string
  readonly done?: boolean
}

/** Read one streamed-text flush, refusing malformed records. */
function progressOf(data: unknown): AutobioMemoryProgressData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.attempt !== 'number' || typeof record.delta !== 'string') return undefined
  if (record.done !== undefined && record.done !== true) return undefined
  return record as unknown as AutobioMemoryProgressData
}

/** Read the tick payload, refusing records without numeric stats. */
function memoryOf(data: unknown): AutobioMemoryEventData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const fields = ['chunksTotal', 'chunksCompressed', 'l1', 'l2', 'l3', 'pendingMerges'] as const
  if (!fields.every(field => typeof record[field] === 'number')) return undefined
  if (record.attempt !== undefined && typeof record.attempt !== 'number') return undefined
  const mint = mintOf(record.memory)
  return {
    chunksTotal: record.chunksTotal as number,
    chunksCompressed: record.chunksCompressed as number,
    l1: record.l1 as number,
    l2: record.l2 as number,
    l3: record.l3 as number,
    pendingMerges: record.pendingMerges as number,
    ...record.attempt === undefined ? {} : { attempt: record.attempt as number },
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
    // The event types are engine-owned; the loose comparison matches
    // compactSource's treatment of plugin-owned source fields. One row per
    // memory-formation call: the call's streamed flushes and the recollection
    // it mints share the attempt-keyed identity.
    const type = event.type as string
    if (type === 'autobio/memory') {
      const stats = memoryOf(event.data)
      if (stats === undefined) return null
      const id = stats.attempt === undefined
        ? `autobio-memory-tick-${event.seq}`
        : `autobio-memory-attempt-${stats.attempt}`
      return { id, role: 'update' }
    }
    if (type === 'autobio/memory-progress') {
      const progress = progressOf(event.data)
      return progress === undefined ? null : { id: `autobio-memory-attempt-${progress.attempt}`, role: 'update' }
    }
    return null
  },
  start: () => ({}),
  update: context => context.state,
  buildViewNode: (context) => {
    // State carries nothing: the newest loaded records win, whether they
    // arrived live, in the initial window, or inside a prepended page. Every
    // accepted match passed its validator, so the payload re-reads cannot fail.
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a context exists only once matched
    const last = context.matches[context.matches.length - 1]!

    // A live stream shows while the newest record is a non-terminal flush:
    // concatenate the trailing run of flushes from the same bridge call.
    let streaming: string | undefined
    if ((last.event.type as string) === 'autobio/memory-progress') {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- match() accepted this record through progressOf
      const lastProgress = progressOf(last.event.data)!
      if (lastProgress.done !== true) {
        const deltas: string[] = []
        for (let index = context.matches.length - 1; index >= 0; index--) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
          const match = context.matches[index]!
          // Matches share the attempt-keyed identity, so the run can only end
          // at the call's own mint record.
          if ((match.event.type as string) !== 'autobio/memory-progress') break
          // oxlint-disable-next-line typescript/no-non-null-assertion -- match() accepted this record through progressOf
          deltas.unshift(progressOf(match.event.data)!.delta)
        }
        streaming = deltas.join('')
      }
    }

    // Stats and the minted recollection come from the newest tick record; a
    // stream's first flushes can precede the first completed tick.
    let stats: AutobioMemoryEventData | undefined
    for (let index = context.matches.length - 1; index >= 0; index--) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const match = context.matches[index]!
      if ((match.event.type as string) !== 'autobio/memory') continue
      // oxlint-disable-next-line typescript/no-non-null-assertion -- match() accepted this record through memoryOf
      stats = memoryOf(match.event.data)!
      break
    }

    return chatNode(context, 'autobio-memory', last.event.seq, {
      kind: 'autobio-memory',
      seq: last.event.seq,
      time: last.event.time,
      chunksTotal: stats?.chunksTotal ?? 0,
      chunksCompressed: stats?.chunksCompressed ?? 0,
      l1: stats?.l1 ?? 0,
      l2: stats?.l2 ?? 0,
      l3: stats?.l3 ?? 0,
      pendingMerges: stats?.pendingMerges ?? 0,
      ...stats?.memory === undefined ? {} : { memory: stats.memory },
      ...streaming === undefined ? {} : { streaming },
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
