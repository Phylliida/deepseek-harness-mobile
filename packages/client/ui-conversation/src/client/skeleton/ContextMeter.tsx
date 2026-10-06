/** Composer context-occupancy meter: a ring beside the send button fed by the
 * `contextPressure` projection, with a click-open panel of the heuristic
 * `contextBreakdown` composition (system prompt, tools, conversation).
 * Renders nothing until a provider reports both pressure and a route
 * capacity. */

import { useEffect, useRef, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the `contextPressure` / `contextBreakdown` projection key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
// Type-only: the `compactionConfig` projection key merge.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy, formatTokens } from '../chat/StatsLine.tsx'
import css from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\u0000'

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
  /** The bar's memory-settings writer; absent without a session. */
  setMemoryConfig?: ComposerBarProps['setMemoryConfig']
}

/** Folding-threshold preset chips, in ascending order. */
const PRESETS = [32_000, 64_000, 128_000] as const

export function ContextMeter({ useProjection, t, setMemoryConfig }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const memory = useProjection('compactionConfig')
  const [open, setOpen] = useState(false)
  // The threshold input's uncommitted text; undefined while the control shows
  // the projection's value.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  // Controls disable while a write is in flight; a rejected write leaves the
  // projection unchanged, which snaps every control back on its own.
  const [writing, setWriting] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  // Outside click / Escape close, one document listener while open (Menu's pattern).
  useEffect(() => {
    if (!open || !available) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [available, open])

  if (context === null) return null
  const percent = context.percent

  const write = (settings: { enabled?: boolean; operatingWindowTokens?: number | null }): void => {
    if (setMemoryConfig === undefined) return
    setWriting(true)
    setMemoryConfig(settings)
      .catch(() => { /* A rejected write never moved the projection; controls snap back on their own. */ })
      .finally(() => { setWriting(false) })
  }

  const commitThreshold = (): void => {
    if (draft === undefined) return
    const parsed = Number(draft)
    setDraft(undefined)
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed === memory?.operatingWindowTokens) return
    write({ operatingWindowTokens: parsed })
  }
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())

  // The bar's overall length stays the provider-exact percent; the heuristic
  // breakdown only proportions its colored parts. A zero-width part is dropped
  // instead of rendered: `.segment`'s min-width keeps a hairline part visible,
  // which at 0% occupancy would draw a filled bar over an empty context.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('context.aria', { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('context.aria', { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('context.used')}>
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <dl className={css.rows}>
              {ROWS.map(row => (
                <div key={row.key} className={css.row}>
                  <dt>
                    <span className={`${css.swatch} ${row.color}`} aria-hidden />
                    {t(row.label)}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key])}`}</dd>
                </div>
              ))}
            </dl>
          )}
          {memory !== undefined && (
            <div className={css.section}>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('context.memory')}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={memory.enabled}
                  aria-label={t('context.memory.toggle')}
                  className={memory.enabled ? css.toggleOn : css.toggle}
                  disabled={writing || setMemoryConfig === undefined}
                  onClick={() => { write({ enabled: !memory.enabled }) }}
                />
              </div>
              <div className={css.row}>
                <label className={css.rowLabel} htmlFor="context-memory-threshold">
                  {t('context.memory.threshold')}
                </label>
                <input
                  id="context-memory-threshold"
                  className={css.thresholdInput}
                  type="number"
                  min={1}
                  step={1000}
                  disabled={writing || setMemoryConfig === undefined || !memory.enabled}
                  placeholder={t('context.memory.default')}
                  value={draft ?? (memory.operatingWindowTokens === null ? '' : String(memory.operatingWindowTokens))}
                  onChange={(e) => { setDraft(e.target.value) }}
                  onBlur={commitThreshold}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitThreshold() }}
                />
              </div>
              <div className={css.chips}>
                {PRESETS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className={memory.operatingWindowTokens === preset ? css.chipActive : css.chip}
                    disabled={writing || setMemoryConfig === undefined || !memory.enabled}
                    onClick={() => { write({ operatingWindowTokens: preset }) }}
                  >
                    {`${preset / 1000}k`}
                  </button>
                ))}
                <button
                  type="button"
                  className={memory.operatingWindowTokens === null ? css.chipActive : css.chip}
                  disabled={writing || setMemoryConfig === undefined || !memory.enabled}
                  onClick={() => { write({ operatingWindowTokens: null }) }}
                >
                  {t('context.memory.default')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </span>
  )
}
