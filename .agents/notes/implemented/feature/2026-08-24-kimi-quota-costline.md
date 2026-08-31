# Agent Note: Kimi Code quota segment on the cost line

Status: implemented

English | [中文](2026-08-24-kimi-quota-costline.zh.md)

## Problem

Deployments running on a Kimi Code subscription answer to three allowance clocks — a rolling 5-hour rate window, a weekly quota, and a monthly membership quota — but the composer dock showed only the [session cost estimate](2026-08-14-session-cost-estimate-line.md). Hitting the 5-hour window arrived as a surprise mid-turn API failure, and checking remaining quota meant leaving the product for the Kimi console. The ask was the quota readout next to the estimate.

## Decision

**One stateless Host Remote owns the fetch.** `packages/host/kimi-quota` (`@deepseek-ai/dsh-host-kimi-quota`) registers the `kimiQuota` service with one generated direct method, `kimiQuota/current`. Each call resolves the configured credential reference through `ctx.credentials` (default `KIMI_API_KEY`, the pi-ai catalog name), GETs `${baseUrl}/v1/usages` (default `https://api.kimi.com/coding`, 8s timeout), and returns the parsed rows: rolling windows (keyed by length in minutes; 300 is the 5-hour window), the weekly row, and the monthly row when the platform payload's `totalQuota` carries one. The parser is loose on purpose — the platform has shipped numbers as decimal strings and spelled the reset instant several ways — and rows without a positive limit are dropped.

**Unavailability is `null`, not an error.** An unconfigured credential, a rejected key, or an unreachable platform all resolve to `null`, and the readout hides the segment. The quota line is ambient information; a fetch failure must not surface per render, and configuration surfaces can already tell the causes apart through `ctx.credentials.describe`.

**The client polls; the Host never pushes.** `ui-cost-estimate`'s browser half binds a quota store that calls `current()` on mount and once a minute (the cadence Kimi Code's own CLI rate-limits its quota fetch to), publishing one stable snapshot reference per actual change. A rejected poll keeps the previous snapshot, so one failure does not flicker the segment off. The service therefore owns no timer, cache, or event stream, and no forwarded-event allowlist entry exists for quota.

**The segment rides the existing cost line.** `CostLine` appends `5h 21% · wk 32% · mo 40/300` (percent when the platform's limit is the percent scale 100, absolute otherwise) after the estimate, with per-row reset hints in the tooltip. A session that has billed no tokens still renders the quota-only row; with neither spend nor quota the row elides as before. The web bundle mounts the host plugin by default, so non-Kimi deployments ship the hidden-null path.

## Alternatives considered

**Host poller plus a forwarded `kimi-quota/updated` event.** Rejected: it adds a timer lifecycle, a cache with its own change detection, and an `API_REMOTE_FORWARDED_EVENTS` entry to push data the single browser consumer can pull on a one-minute cadence; the push version buys fresher numbers nobody reads between polls.

**A generic provider-quota capability seam.** Rejected: exactly one platform (Kimi Code) and one consumer (the cost line) exist; the package name, Config, and payload types stay Kimi-specific until a second provider's quota endpoint justifies the abstraction.

**Browser-direct fetch.** Rejected: the browser never holds the API key (credentials are Host-resolved) and the platform endpoint answers no CORS headers, so a browser fetch could not work without a Host relay either way.

**Folding the Remote into an existing host package.** Rejected: the fetch is a self-contained capability with its own Config and failure semantics; plugin-inventory is the template for one-Remote packages, and the web bundle opts in with one row.

## Consequences

The cost line now answers "how much room is left on my subscription" in place, and the 5-hour window's reset hint is one hover away. The price is one more host package mounted by default in the web bundle, a `remote.kimiQuota` inject edge in ui-cost-estimate, and a monthly row that appears only when the platform reports one (plans whose payload carries an empty `totalQuota` show no monthly segment). The readout is per-call live: there is no stale-cache correctness surface, at the cost of one `/usages` request per browser per minute.
