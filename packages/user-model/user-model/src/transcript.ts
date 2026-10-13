/**
 * Role-flipped transcript construction: the session's derived history viewed
 * from the user-model's chair. The agent's words become the auxiliary call's
 * "user" role, the human's (and earlier user-model replies) become its
 * "assistant" role. Non-text blocks are folded to tagged text so the
 * user-model sees tool activity it needs to judge progress.
 *
 * @module @deepseek-ai/dsh-user-model/transcript
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { UserModelSelection } from './types.ts'

/** Plugin identity recorded on the flipped user-role messages. */
const PLUGIN = 'dsh-user-model'

/** Extract readable text from one block's nested content, recursing through tool results. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'tool-result':
      return block.content.map(blockText).join('\n')
    default:
      return `[${block.type}]`
  }
}

/**
 * Fold one block to what the user-model should read: text passes through
 * (reusing the shared frozen blocks), tool calls and results become tagged
 * text, images and unknown blocks become bare type tags.
 * @param block - one content block of the session-derived history.
 * @returns the flipped content blocks.
 */
function flipBlock(block: ContentBlock): ContentBlock[] {
  switch (block.type) {
    case 'text':
      return [block]
    case 'reasoning':
      return []
    case 'tool-call':
      return [{ type: 'text', text: `[tool call] ${block.name}: ${block.arguments}` }]
    case 'tool-result':
      return [{ type: 'text', text: `[tool result${block.isError === true ? ', error' : ''}] ${blockText(block)}` }]
    default:
      return [{ type: 'text', text: `[${block.type}]` }]
  }
}

/** Fold a whole message's content, dropping messages left with no visible blocks. */
function flipContent(message: Message): ContentBlock[] {
  return message.content.flatMap(flipBlock)
}

/**
 * Build the auxiliary transcript: every session message with surviving
 * content, role-flipped and re-identified. Flipped assistant-side messages
 * carry the user-model's own route as provenance — the auxiliary transcript
 * is in-memory only, and the `user-model/request` log event records it
 * verbatim beside the true route.
 * @param messages - the session's derived history (`session.deriveMessages()`).
 * @param selection - the armed selection whose route marks flipped assistant messages.
 * @returns the role-flipped auxiliary message list.
 */
export function buildUserModelTranscript(
  messages: readonly Message[],
  selection: UserModelSelection,
): Message[] {
  const transcript: Message[] = []
  for (const message of messages) {
    const content = flipContent(message)
    if (content.length === 0) continue
    if (message.role === 'assistant') {
      transcript.push(createUserMessage({
        content,
        source: { kind: 'plugin', plugin: PLUGIN, form: 'relay' },
      }))
    } else if (message.role === 'user') {
      transcript.push(createAssistantMessage({
        content,
        source: { provider: selection.provider, model: selection.model },
      }))
    }
  }
  return transcript
}
