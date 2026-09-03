// Session cost estimate line: mounted on 'conversation.composer.dock' at
// order -1 so it leads the stats row (same mounted-with-the-composer family
// as StatsLine; see ConversationRoot data-conversation-scroll).

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the Kimi quota snapshot vocabulary crosses the Host boundary through the Client assembly.
import type { KimiQuotaSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: merges the tokenUsage key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { estimateSessionCost, formatBudgetPercent, formatCost, formatTokens } from '../cost.ts'
import type { CostEstimateSettings } from '../cost-settings.ts'
import { formatQuotaSegments, formatQuotaTooltip } from './quota-format.ts'
import css from './CostLine.module.css'

/** Injected business face: the configured rates/budget and the Kimi quota ride the reserved hooks compartment. */
export interface CostLineInjected {
  hooks: {
    /** Configured section (rates and weekly budget), one stable snapshot per actual change. */
    settings: SnapshotStore<CostEstimateSettings>
    /** Latest Kimi Code subscription quota, or null while unavailable (a stable snapshot per change). */
    quota: SnapshotStore<KimiQuotaSnapshot | null>
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
 * weekly budget, plus the Kimi Code subscription quota segment when the Host
 * quota Remote reports one. The figure rides the durable `tokenUsage`
 * projection, so paging and compaction cannot change it; provider-reported
 * billed amounts sum in as fact while everything else is priced from the
 * configured rates (see {@link estimateSessionCost}). The row drops out whole
 * until a session has billed tokens or a quota snapshot has arrived.
 * @param props - composed slot props.
 * @returns the line element, or null while nothing billable or quotable exists.
 */
export function CostLine({ useProjection, useSettings, useQuota, t }: CostLineProps) {
  const usage = useProjection('tokenUsage')
  const settings = useSettings(value => value)
  const quota = useQuota(value => value)
  const quotaSegment = quota === null ? '' : formatQuotaSegments(quota, t)
  const quotaDetail = quota === null ? '' : formatQuotaTooltip(quota, t)
  // Every bucket is non-negative, so one sum decides whether anything billed.
  const billed = usage !== undefined
    && usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens > 0
  if (!billed) {
    if (quotaSegment === '') return null
    return (
      <Tooltip label={quotaDetail} side="top" delayMs={500}>
        <div className={css.root}>{quotaSegment}</div>
      </Tooltip>
    )
  }
  const spend = estimateSessionCost(usage, settings.rates)
  const breakdown = t('breakdown', {
    input: formatTokens(usage.uncachedInputTokens),
    cache: formatTokens(usage.cacheReadTokens),
    write: formatTokens(usage.cacheWriteTokens),
    output: formatTokens(usage.outputTokens),
  })
  const quotaText = quotaSegment === '' ? '' : ` · ${quotaSegment}`
  // A zero budget disables the share readout entirely.
  if (settings.weeklyBudgetUsd <= 0) {
    const label = quotaDetail === '' ? breakdown : `${breakdown} · ${quotaDetail}`
    return (
      <Tooltip label={label} side="top" delayMs={500}>
        <div className={css.root}>{t('line', { cost: formatCost(spend), percent: '' })}{quotaText}</div>
      </Tooltip>
    )
  }
  const percent = formatBudgetPercent(spend, settings.weeklyBudgetUsd)
  const parts = [breakdown, t('budget', { budget: `$${settings.weeklyBudgetUsd}`, percent })]
  if (quotaDetail !== '') parts.push(quotaDetail)
  return (
    <Tooltip label={parts.join(' · ')} side="top" delayMs={500}>
      <div className={css.root}>{t('line', { cost: formatCost(spend), percent: ` (${percent})` })}{quotaText}</div>
    </Tooltip>
  )
}
