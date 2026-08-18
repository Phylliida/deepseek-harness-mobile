// Session cost estimate line: mounted on 'conversation.composer.dock' at
// order -1 so it leads the stats row (same mounted-with-the-composer family
// as StatsLine; see ConversationRoot data-conversation-scroll).

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: merges the tokenUsage key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { estimateCost, formatBudgetPercent, formatCost, formatTokens } from '../cost.ts'
import type { CostEstimateSettings } from '../cost-settings.ts'
import css from './CostLine.module.css'

/** Injected business face: the configured rates and budget ride the reserved hooks compartment. */
export interface CostLineInjected {
  hooks: {
    /** Configured section (rates and weekly budget), one stable snapshot per actual change. */
    settings: SnapshotStore<CostEstimateSettings>
  }
}

/**
 * Full component props: the projection seat the dock's stats-line family
 * consumes (same minimal share StatsLine hand-mirrors — the owner `zone`
 * share stays at the render site) + locale seat + injected settings hook.
 */
export type CostLineProps = { useProjection: UseProjection }
  & InjectFace<CostLineInjected>
  & PropsLocale<'cost'>

/**
 * Render the whole-session cost estimate with its share of the configured
 * weekly budget. The figure rides the durable `tokenUsage` projection, so
 * paging and compaction cannot change it; the row drops out whole until a
 * session has billed tokens.
 * @param props - composed slot props.
 * @returns the line element, or null while no tokens were billed.
 */
export function CostLine({ useProjection, useSettings, t }: CostLineProps) {
  const usage = useProjection('tokenUsage')
  const settings = useSettings(value => value)
  if (usage === undefined) return null
  const billedInput = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (billedInput === 0 && usage.outputTokens === 0) return null
  const spend = estimateCost(usage, settings.rates)
  const breakdown = t('breakdown', {
    input: formatTokens(usage.uncachedInputTokens),
    cache: formatTokens(usage.cacheReadTokens),
    write: formatTokens(usage.cacheWriteTokens),
    output: formatTokens(usage.outputTokens),
  })
  // A zero budget disables the share readout entirely.
  if (settings.weeklyBudgetUsd <= 0) {
    return (
      <Tooltip label={breakdown} side="top" delayMs={500}>
        <div className={css.root}>{t('line', { cost: formatCost(spend), percent: '' })}</div>
      </Tooltip>
    )
  }
  const percent = formatBudgetPercent(spend, settings.weeklyBudgetUsd)
  const label = `${breakdown} · ${t('budget', { budget: `$${settings.weeklyBudgetUsd}`, percent })}`
  return (
    <Tooltip label={label} side="top" delayMs={500}>
      <div className={css.root}>{t('line', { cost: formatCost(spend), percent: ` (${percent})` })}</div>
    </Tooltip>
  )
}
