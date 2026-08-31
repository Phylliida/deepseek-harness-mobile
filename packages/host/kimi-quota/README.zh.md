# @deepseek-ai/dsh-host-kimi-quota

[English](README.md) | 中文

Kimi Code 订阅配额 Remote。`KimiQuotaService` 注册 `kimiQuota` 服务，并发布一个生成的直连 Remote：`kimiQuota/current`。每次调用都会通过 `ctx.credentials` 解析配置的凭据引用，GET 托管平台的 `/v1/usages` 端点，并返回解析后的配额行：滚动速率限制窗口（当前套餐的 5 小时窗口）、每周配额，以及平台报告时的每月会员配额。

该服务按设计保持无状态：不持有缓存、轮询器或事件流，因此每次调用都报告平台当前的真实值，刷新节奏由调用方决定。凭据未配置或平台不可达时返回 `null` 而不是报错，让读数界面降级为隐藏配额段。公开载荷类型位于 `./types`，Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 构件。

## 配置

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `https://api.kimi.com/coding` | 托管平台基础 URL；自动追加 `/v1/usages`。 |
| `apiKeyEnv` | `KIMI_API_KEY` | 持有 Kimi Code API key 的凭据引用（环境变量名）。 |
| `timeoutMs` | `8000` | `/usages` 请求超时（毫秒）。 |

## Model Experience

无，该 Host 侧配额投射不注册任何 prompt、工具、消息或 provider 请求。

#### KV Cache effect

无；本包从不组装模型输入。

## Known Limitations and Deferred Work

- **仅平台报告的行** — 每月会员配额仅在平台载荷携带时出现；从不报告每月配额的套餐不会渲染每月行。
- **不区分失败原因** — 凭据未配置、key 被拒与平台不可达都返回 `null`；配置界面应使用 `ctx.credentials.describe` 加以区分。
