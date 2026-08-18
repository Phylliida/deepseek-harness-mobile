# Agent Note：会话费用估算行

Status: implemented

[English](2026-08-14-session-cost-estimate-line.md) | 中文

## 问题

阅读 composer 停靠区汇总带的用户能看到轮次、时长、吞吐、缓存命中率和 token 总量，但没有任何内容把这些总量换算成钱。给会话计价需要手工把 token 计数搬到计算器里对着提供商费率表算，而当前默认模型（Kimi K3）的费率在产品之外。需求是在该汇总带的最前面放一条按 K3 标准 API 费率计价的估算，同时不把费率表锁死在单一提供商上。

## 决定

**一个双端客户端包持有整个功能。** `@deepseek-ai/dsh-client-ui-cost-estimate` 把完整能力收在 `packages/client/ui-cost-estimate`：Host 入口注册持久的 `ui-cost-estimate` 设置段（`rates`：无缓存输入、缓存读取、缓存写入、输出；美元每百万 token，默认取 Moonshot 的 K3 标准费率 `$3 / $0.30 / $3 / $15`，缓存写入按普通输入计费），浏览器入口展示估算。不新增 Host 侧 token 记账包：`dsh-token-meter` 的持久 `tokenUsage` 投影已经是整个日志的计费 fold，费用是它的纯函数。

**估算是展示层算术，不是新 fold。** 浏览器行读取 `useProjection('tokenUsage')` 与设置绑定的费率 hook，因此翻页、压缩、重连下数值天然成立。Host 侧 `sessionCost` 投影被拒绝：它会重复 fold `tokenUsage` 投影已经 fold 过的同一批事件、复制 token-meter 的用量逻辑，却买不到客户端推导不出的任何东西——这正对应 token-meter 自身“提供商锚定数值”与“UI 展示”的划分。

**费率走用户设置，不走插件 Config。** 客户端启动条目不携带 cordis config，cordis `Config` 到不了渲染端。设置命名空间提供校验（费率非负）、持久覆盖和经现有作用域传输的实时失效通知；没有设置提供方的部署保持 schema 默认值。这与 `ui-theme` / `ui-conversation` 的 UI 偏好先例一致。

**位置由显式 slot 排序决定。** 该行以 `order: -1` 注册在 `conversation.composer.dock` 上，位于 stats 行的 `0` 之前，估算因此领跑汇总带而无需改动 ui-conversation——stats 行继续拥有自己的内容。会话尚无计费 token 时整行不渲染。

## 备选方案

**扩展 dsh-token-meter 增加成本投影。** 拒绝：token-meter 的契约有意固定其启发式并拒绝设置；费率表随部署和用户变化，“按费率计价”与 token 测量是不同关注点。

**在 ui-conversation 的 StatsLine 内加费用组。** 拒绝：它把功能硬编码进会话包，费率没有有原则的家，还把第二个能力的所有权混进 stats 行内容。

**把费率作为常量打进客户端 bundle。** 拒绝：费率正是设置 seam 存在的理由——随部署变化的输入；K3 重定价那天硬编码价格就过期了。

## 后果

编辑用户设置文档中的 `ui-cost-estimate.rates` 会为所有会话实时重算显示。不同定价模型的会话共用一张表（已记录为限制）。估算仅供显示，从不喂给 agent 行为，因此不需要新会话事件，model-visible⟹logged 不变量不受影响。Settings 页面费率编辑器留在包 README 的待办中。
