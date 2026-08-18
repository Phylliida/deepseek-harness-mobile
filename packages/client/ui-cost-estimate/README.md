# @deepseek-ai/dsh-client-ui-cost-estimate

English | [中文](README.zh.md)

Session cost estimate for the composer dock: a stats-family line above the stats row pricing the session's whole durable token log at a user-configurable rate table. Both halves ship from one package — the Host entry owns the settings section, the browser entry renders the estimate.

## What it shows

The line reads the durable `tokenUsage` projection (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) and multiplies each bucket by the configured per-million-token rate. It registers on `conversation.composer.dock` at `order: -1`, ahead of the stats row's `0`, so the estimate leads the summary band below the composer. Hovering shows the per-bucket breakdown; both locales ship in the package. The row renders nothing until a session has billed tokens, and the figure is a reference estimate, not a billing record — billing remains the provider's own account.

Because the figure is a pure function of the durable projection and the durable settings section, it survives paging, compaction, and reconnects without any resident bookkeeping: no cross-plugin mutable state exists to desynchronize.

The line also states the estimate's share of the configured weekly budget — `est. cost ~$5.10 (4.3%)` — and the hover breakdown adds the budget sentence. A zero `weeklyBudgetUsd` drops the share from the line.

## Rates and budget configuration

Settings live in the Host user-settings document under the `ui-cost-estimate` namespace: a `rates` field with four non-negative USD-per-million-token prices, and a `weeklyBudgetUsd` field the estimate is shown as a percent of (default `$120`; `0` hides the share readout). Rate defaults are Moonshot's published Kimi K3 standard API rates — uncached input `$3`, cache read `$0.30`, cache write `$3` (K3 bills cache writes as ordinary input), output `$15` — and individual values the document omits fall back to them. Edit the section in the user-settings document to price a different provider or re-anchor the budget; the browser scope picks the change up live through the settings invalidation, and the line reprices with no reload.

```yaml
ui-cost-estimate:
  rates: { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 }
  weeklyBudgetUsd: 120
```

A deployment without a settings provider keeps the defaults: the browser scope falls back to the schema defaults while its namespace is absent.

## Model Experience

None, as the composer-dock estimate renders durable token totals at a rate table; nothing here reaches a model request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No in-UI rates editor** — the section is edited in the user-settings document only; a Settings-page row with four numeric fields is deferred until someone asks for it.
- **One rate table per deployment** — sessions on differently priced models share the table; per-adapter rate routing would need model identity in the fold, which the durable projection deliberately does not carry into UI arithmetic.
- **Estimates clip display precision, not arithmetic** — costs under a cent show four decimals, and the budget share floors a nonzero share under one permille to `<0.1%`; exact figures stay available through the hover breakdown's token counts and the configured rates.
