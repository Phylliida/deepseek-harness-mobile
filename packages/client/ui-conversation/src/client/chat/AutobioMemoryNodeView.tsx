/**
 * One memory-formation call's disclosure, built as the Think row is: a single
 * preview line that follows the recollection while it streams and rests on its
 * opening line once settled, with the whole text disclosed on click.
 */

import { useEffect, useRef, useState } from 'react'
import { DisclosureRow, IconApiOutline14, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { useThrottledVisualUpdate } from './use-throttled-visual-update.ts'
import a11yCss from './accessibility.module.css'
import css from './AutobioMemoryRow.module.css'

/** The line a settled recollection previews, or nothing while it has no text yet. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** The line a streaming call has reached, so the preview follows the writing. */
function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one memory-formation call as a preview row with its recollection disclosed.
 * @param props.node - the row's streamed or settled recollection text.
 * @param props.t - conversation locale seat for the row title and running status.
 * @returns the memory-formation disclosure.
 */
export const AutobioMemoryNodeView = function AutobioMemoryNodeView({
  node, t,
}: ChatNodeViewProps<'autobio-memory'>) {
  const [expanded, setExpanded] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const { text, streaming } = node.data
  const summary = streaming ? latestLine(text) : firstLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = streaming ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [streaming, scheduleSummaryScroll, summary])

  return (
    <div className={css.root} data-state={streaming ? 'running' : 'ok'}>
      {streaming && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconApiOutline14 />}
        title={t('message.autobio.memory')}
        open={expanded}
        expandable={text !== ''}
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={summary === '' ? undefined : (
          <>
            <span className={css.separator} aria-hidden />
            <span ref={summaryRef} className={css.summary} data-follow-end={streaming || undefined}>{summary}</span>
          </>
        )}
      >
        <div className={css.body}><MarkdownText text={text} /></div>
      </DisclosureRow>
    </div>
  )
}
