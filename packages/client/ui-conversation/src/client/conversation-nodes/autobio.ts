import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import { chatNode } from './common.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One memory-formation call: its streamed recollection, live then settled. */
    'autobio-memory': AutobioMemoryNode
  }
}

/** The text one memory-formation call's row carries. */
export interface AutobioMemoryNode {
  readonly kind: 'autobio-memory'
  readonly seq: number
  /** Streamed text, replaced by the minted recollection once the call settles. */
  readonly text: string
  /** Whether the call is still streaming; false once it settled. */
  readonly streaming: boolean
}

/**
 * One row per memory-formation call, keyed by the attempt both record types
 * report. Either type may arrive first, so every Match is an update and the row
 * reads its own Matches rather than State the assembler would have to seed.
 */
export const autobioMemoryDefinition: ConversationNodeDefinition<Record<string, never>> = {
  kind: 'autobio-memory',
  target: 'chat',
  match: (event) => {
    const attempt = (event.data as { attempt?: unknown }).attempt
    return typeof attempt === 'number' && (event.type as string).startsWith('autobio/')
      ? { id: `autobio-attempt-${attempt}`, role: 'update' }
      : null
  },
  start: () => ({}),
  update: context => context.state,
  buildViewNode: (context) => {
    let seq = 0
    let text = ''
    let streaming = false
    for (const match of context.matches) {
      const data = match.event.data as { delta?: unknown; done?: unknown; memory?: { content?: unknown } }
      seq = match.event.seq
      if ((match.event.type as string) === 'autobio/memory-progress') {
        if (typeof data.delta === 'string') text += data.delta
        streaming = data.done !== true
      } else if (typeof data.memory?.content === 'string') {
        text = data.memory.content
        streaming = false
      }
    }
    return chatNode(context, 'autobio-memory', seq, { kind: 'autobio-memory', seq, text, streaming })
  },
}

/**
 * Register the memory-formation row contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAutobioMemoryConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(autobioMemoryDefinition)
}
