# Agent Note: 费用行的 Kimi Code 配额段

Status: implemented

[English](2026-08-24-kimi-quota-costline.md) | 中文

## Problem

跑在 Kimi Code 订阅上的部署受三把配额时钟约束——滚动 5 小时速率窗口、每周配额、每月会员配额——但 composer 停靠栏只显示[会话费用估计](2026-08-14-session-cost-estimate-line.md)。撞上 5 小时窗口表现为回合中途突如其来的 API 失败，查剩余配额还得离开产品去 Kimi 控制台。需求是把配额读数放到估计旁边。

## Decision

**一个无状态 Host Remote 拥有抓取。** `packages/host/kimi-quota`（`@deepseek-ai/dsh-host-kimi-quota`）注册 `kimiQuota` 服务，发布一个生成的直连方法 `kimiQuota/current`。每次调用通过 `ctx.credentials` 解析配置的凭据引用（默认 `KIMI_API_KEY`，即 pi-ai 目录里的名字），GET `${baseUrl}/v1/usages`（默认 `https://api.kimi.com/coding`，8 秒超时），返回解析后的行：滚动窗口（以分钟数长度标记；300 即 5 小时窗口）、每周行，以及平台载荷的 `totalQuota` 携带时的每月行。解析器有意宽松——平台曾以十进制字符串下发数字、用多种拼写表示重置时刻——没有正数 limit 的行会被丢弃。

**不可用是 `null`，不是错误。** 凭据未配置、key 被拒、平台不可达都解析为 `null`，读数界面隐藏该段。配额行是环境信息；抓取失败不能随每次渲染冒出，而配置界面本就能通过 `ctx.credentials.describe` 区分这些原因。

**客户端轮询；Host 从不推送。** `ui-cost-estimate` 的浏览器半端绑定一个配额 store：挂载时调用一次 `current()`，之后每分钟一次（与 Kimi Code 自家 CLI 对配额抓取的限速一致），每次实际变化发布一个稳定快照引用。被拒的轮询保留上一快照，一次失败不会让该段闪烁消失。因此该服务不持有定时器、缓存或事件流，配额也没有转发事件白名单条目。

**配额段搭乘现有费用行。** `CostLine` 在估计后追加 `5h 21% · wk 32% · mo 40/300`（平台的 limit 为百分比刻度 100 时按百分比显示，否则按绝对值），tooltip 里给出每行的重置提示。尚未计费任何 token 的会话仍渲染纯配额行；花费与配额都没有时该行照常整体隐藏。web bundle 默认挂载该 host 插件，非 Kimi 部署走的是隐藏的 null 路径。

## Alternatives considered

**Host 轮询器加转发的 `kimi-quota/updated` 事件。** 拒绝：它要引入定时器生命周期、带变化检测的缓存，以及一条 `API_REMOTE_FORWARDED_EVENTS` 条目，去推送唯一浏览器消费者自己就能按一分钟节奏拉取的数据；推送版换来的更新鲜的数字在两次轮询之间也没人读。

**通用的 provider 配额能力 seam。** 拒绝：现存恰好一个平台（Kimi Code）和一个消费者（费用行）；包名、Config 与载荷类型保持 Kimi 专属，直到第二个 provider 的配额端点证明抽象合理。

**浏览器直接抓取。** 拒绝：浏览器从不持有 API key（凭据由 Host 解析），且平台端点不返回 CORS 头，浏览器抓取没有 Host 中转本来就行不通。

**把 Remote 折进现有 host 包。** 拒绝：这次抓取是自带 Config 与失败语义的自包含能力；plugin-inventory 就是单 Remote 包的模板，web bundle 一行即可挂载。

## Consequences

费用行现在原地回答"我的订阅还剩多少空间"，5 小时窗口的重置提示一次悬停即达。代价是 web bundle 默认多挂载一个 host 包、ui-cost-estimate 多一条 `remote.kimiQuota` inject 边，以及一个仅在平台报告时才出现的每月行（载荷携带空 `totalQuota` 的套餐不显示每月段）。读数是逐调用实时的：不存在陈旧缓存的正确性面，代价是每个浏览器每分钟一次 `/usages` 请求。
