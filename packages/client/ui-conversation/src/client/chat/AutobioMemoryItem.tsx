// AutobioMemoryItem: the autobiographical backend's memory-formation status
// row. One persistent row updates in place as compression ticks land, so
// background memory work is visible in the flow without a row per tick. When
// the newest tick minted a recollection, the row discloses it on click.

import { memo, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutobioMemoryNode } from '../conversation-nodes/autobio-memory.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './MessageItem.module.css'

interface AutobioMemoryItemProps {
  node: AutobioMemoryNode
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/** Render the latest strategy stats as one quiet status line with a memory disclosure. */
export const AutobioMemoryItem = memo(function AutobioMemoryItem({ node, t }: AutobioMemoryItemProps) {
  const [expanded, setExpanded] = useState(false)
  const streaming = node.streaming !== undefined
  const expandable = node.memory !== undefined
  // A live stream pins the body open over the disclosure state.
  const open = streaming || (expandable && expanded)
  const stats = t('message.autobio.memory.stats', {
    summaries: node.l1 + node.l2 + node.l3,
    chunks: node.chunksTotal,
    l1: node.l1,
    l2: node.l2,
    l3: node.l3,
  })
  const summary = node.memory === undefined
    ? stats
    : `${stats} · ${t('message.autobio.memory.entry', { id: node.memory.id, tokens: node.memory.tokens })}`
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable && !streaming}
        aria-expanded={open ? true : (expandable ? false : undefined)}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutline14 />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle}>
          {streaming ? t('message.autobio.memory.forming') : t('message.autobio.memory')}
        </span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{summary}</span>
      </button>
      {open && node.streaming !== undefined
        && <div className={css.compactionBody}><MarkdownText text={node.streaming} /></div>}
      {open && node.streaming === undefined && node.memory !== undefined
        && <div className={css.compactionBody}><MarkdownText text={node.memory.content} /></div>}
    </div>
  )
})
