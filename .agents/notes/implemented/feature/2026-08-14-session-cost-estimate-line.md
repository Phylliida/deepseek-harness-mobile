# Agent Note: Session cost-estimate line

Status: implemented

English | [中文](2026-08-14-session-cost-estimate-line.zh.md)

## Problem

Users reading the composer dock's summary band see turns, durations, throughput, cache hit, and token totals, but nothing translates those totals into money. Pricing a session requires moving token counts into a calculator with the provider's rate table by hand, and the hand rate for the field's current default model (Kimi K3) lives outside the product. The ask was an estimate at the head of that band priced at K3's standard API rates, without locking the table to one provider.

## Decision

**One dual-ended client package owns the feature.** `@deepseek-ai/dsh-client-ui-cost-estimate` keeps the whole capability in `packages/client/ui-cost-estimate`: the Host entry registers the durable `ui-cost-estimate` settings section (`rates`: uncached input, cache read, cache write, output; USD per million tokens, defaults to Moonshot's K3 standard rates `$3 / $0.30 / $3 / $15` with cache write billed as ordinary input), and the browser entry shows the estimate. No Host token-accounting package changes hands: the durable `tokenUsage` projection from `dsh-token-meter` is already the whole-log billing fold, and cost is a pure function of it.

**The estimate is presentation arithmetic, not a new fold.** The browser line reads `useProjection('tokenUsage')` and the settings-bound rates hook, so the figure survives paging, compaction, and reconnects for free. A Host-side `sessionCost` projection was rejected: it would have re-folded the same events the `tokenUsage` projection already folds, duplicated token-meter's usage logic, and bought nothing the client cannot derive — mirroring token-meter's own split of provider-anchored numbers versus UI-side presentation.

**Rates ride user settings, not plugin config.** Client boot entries carry no cordis config, so cordis `Config` could never reach the renderer. The settings namespace gives validation (non-negative rates), durable overrides, and live invalidation through the existing scope transport; a deployment without a settings provider keeps the schema defaults. This matches the `ui-theme` / `ui-conversation` precedent for UI-owned preferences.

**Placement is explicit slot ordering.** The line registers on `conversation.composer.dock` at `order: -1` against the stats row's `0`, so the estimate leads the summary band without touching ui-conversation — the stats line keeps owning its own content. The row elides entirely until a session has billed tokens.

## Alternatives considered

**Extend dsh-token-meter with a cost projection.** Rejected: token-meter's contract deliberately fixes its heuristics and rejects settings; rate tables are deployment- and user-varying, and billing-at-a-rate is a different concern than token measurement.

**Add a cost group inside ui-conversation's StatsLine.** Rejected: it hardcodes the feature into the conversation package, gives rates no principled home, and mixes a second capability's ownership into the stats row's content.

**Bundle rates into the client as constants.** Rejected: rates are exactly the deployment-varying input the settings seam exists for, and hardcoded prices would age badly the day K3 reprices.

## Consequences

Editing `ui-cost-estimate.rates` in the user-settings document reprices the display live for every session. Sessions priced at different models share one table (documented limitation). The estimate is display-precision only and never feeds agent behavior, so it needs no new session event and the model-visible⟹logged invariant is untouched. A Settings-page rates editor remains deferred work in the package README.
