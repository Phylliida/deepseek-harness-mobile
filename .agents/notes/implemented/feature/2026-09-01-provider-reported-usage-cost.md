# Agent Note: Provider-reported usage cost

Status: implemented

English | [中文](2026-09-01-provider-reported-usage-cost.zh.md)

## Problem

The session cost estimate prices every durable token bucket at one configured flat rate table, so turns a provider bills at its own per-request price were estimated at unrelated rates. OpenRouter reports the actual billed amount on every response's `usage.cost` — including for presets like `@preset/fables`, whose routed model and price no static table can know — and the harness discarded it: pi-ai recomputes cost from its catalog rates (zeroed for hand-declared models), and the seam's `TokenUsage` carried no cost field at all.

## Decision

**Provider-reported billed cost is usage data and rides the usage path.** A pnpm patch on pi-ai (`patches/@earendil-works__pi-ai@0.82.1.patch`) preserves OpenRouter's `usage.cost` as `Usage.providerCost` beside the catalog-estimated `cost` block the library computes. llm-pi-ai's `mapUsage` carries it to the seam's optional `TokenUsage.costUsd`, so the figure is logged with the session's ordinary usage records and needs no new session event. token-meter's `tokenUsage` projection folds it with the same last-sample-replaces semantics as the buckets: totals still cover every sample, while the optional `reportedCostUsd` sums reported cost and the optional `unratedTokens` buckets hold exactly the usage no provider billed. Both fields stay absent until a sample reports a cost, so a deployment without a cost-reporting provider gets unchanged projections. The composer cost line ([Session cost-estimate line](2026-08-14-session-cost-estimate-line.md)) sums `reportedCostUsd` as fact and prices only `unratedTokens` at the configured rates, so a reported call is never priced twice.

**The billed/unrated split lives in the durable fold, not the client.** Per-sample granularity exists only while folding the log; publishing two aggregate bucket families lets mixed sessions (a Kimi-billed step, then an OpenRouter-billed one) price each part correctly while model identity stays out of UI arithmetic.

**A reported zero is a report.** OpenRouter bills `$0` on free endpoints; the fold keys on `costUsd !== undefined`, not on a positive amount, so a free call's tokens still leave the unrated set rather than being priced at configured rates.

## Alternatives considered

**Per-provider rate tables.** Rejected: an OpenRouter preset routes to whatever model the account pinned, so no configured table can price it; the response metadata can, and it reflects routing and discounts no table knows.

**Read pi-ai's catalog-estimated `usage.cost`.** Rejected: hand-declared models materialize with zeroed rates, so the figure is empty exactly where the feature matters, and where it is not empty it is still an estimate competing with the provider's billed fact on the same wire.

**Overwrite `usage.cost` with the reported amount inside the patch.** Rejected: an additive `providerCost` field keeps every existing pi-ai consumer's behavior unchanged and the patch a small upstreamable delta.

## Consequences

Sessions mixing reported and unreported providers read actuals plus one flat-rate estimate; the line's `~` prefix and the README's "reference estimate, not a billing record" wording cover the mix. `tokenUsage` moved to projection `stateVersion: 2`, so persisted version-1 rows refold on read. The patch must be re-applied or upstreamed on pi-ai upgrades — checked at 0.84.4, which still discards the reported cost. Behavior is pinned by package unit tests (mapping, fold split, mixed-session pricing, checkpoint restore) and a live OpenRouter probe showing `providerCost=0.00038` for a 22-token preset call; the web snapshot lane holds no cost-line scenario (none existed before this change, and the lane fails at loader setup on this checkout for unrelated reasons), so adding the first one is deferred.
