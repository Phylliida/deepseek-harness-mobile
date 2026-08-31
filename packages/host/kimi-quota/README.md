# @deepseek-ai/dsh-host-kimi-quota

English | [中文](README.zh.md)

Kimi Code subscription quota Remote. `KimiQuotaService` registers the `kimiQuota` service and publishes one generated direct Remote, `kimiQuota/current`. Every call resolves the configured credential reference through `ctx.credentials`, GETs the managed platform's `/v1/usages` endpoint, and returns the parsed allowance rows: rolling rate-limit windows (the 5-hour window on current plans), the weekly allowance, and the monthly membership allowance when the platform reports one.

The service is stateless by design: it owns no cache, poller, or event stream, so every call reports what the platform reports and refresh cadence belongs to the caller. An unconfigured credential or an unreachable platform resolves to `null` rather than an error, letting readouts degrade to hiding the quota segment. Public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `https://api.kimi.com/coding` | Managed platform base URL; `/v1/usages` is appended. |
| `apiKeyEnv` | `KIMI_API_KEY` | Credential reference (environment-variable name) holding the Kimi Code API key. |
| `timeoutMs` | `8000` | `/usages` request timeout in milliseconds. |

## Model Experience

None, as this Host-only quota projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Platform-reported rows only** — the monthly membership allowance appears only when the platform payload carries it; plans that never report a monthly quota render no monthly row.
- **No failure distinction** — an unconfigured credential, a rejected key, and an unreachable platform all resolve to `null`; configuration surfaces should use `ctx.credentials.describe` to tell them apart.
