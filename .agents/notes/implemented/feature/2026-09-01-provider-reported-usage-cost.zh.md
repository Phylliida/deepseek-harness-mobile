# Agent Note：提供方报告的用量费用

Status: implemented

[English](2026-09-01-provider-reported-usage-cost.md) | 中文

## 问题

会话费用估算此前把每个持久 token 桶都按同一张配置的固定费率表计价，因此由提供方按自身逐请求价格计费的轮次，被套用在了毫不相干的费率上。OpenRouter 在每个响应的 `usage.cost` 上报告实际计费金额——包括 `@preset/fables` 这类 preset，其路由到的模型与价格不是任何静态费率表所能知晓的——而 harness 把它丢弃了：pi-ai 按自身 catalog 费率重算费用（对手工声明的模型费率为零），seam 的 `TokenUsage` 更是根本没有费用字段。

## 决定

**提供方报告的计费金额属于用量数据，随用量路径传递。** 对 pi-ai 的 pnpm 补丁（`patches/@earendil-works__pi-ai@0.82.1.patch`）把 OpenRouter 的 `usage.cost` 保留为 `Usage.providerCost`，与该库自行计算的 catalog 估算 `cost` 块并存。llm-pi-ai 的 `mapUsage` 把它携带到 seam 的可选字段 `TokenUsage.costUsd`，因此该数值随会话的普通用量记录落日志，不需要新的会话事件。token-meter 的 `tokenUsage` 投影以与桶相同的“最新样本替换”语义折叠它：总量仍覆盖每个样本，可选的 `reportedCostUsd` 累加已报告的费用，可选的 `unratedTokens` 桶则恰好只含未被提供方计费的用量。在有任何样本报告费用之前两个字段都保持缺席，因此没有报告费用的提供方的部署得到的投影与之前完全一致。composer 的费用行（见[会话费用估算行](2026-08-14-session-cost-estimate-line.md)）把 `reportedCostUsd` 作为事实直接累加，只用配置费率为 `unratedTokens` 计价，已报告的调用绝不会被重复计价。

**计费/未计费的拆分落在持久 fold 中，而不是客户端。** 逐样本粒度只在折叠日志时存在；发布两族聚合桶让混合会话（先一轮 Kimi 计费、再一轮 OpenRouter 计费）能为各自正确定价，同时模型身份仍不进入 UI 运算。

**报告的零也是一次报告。** OpenRouter 对免费端点计 `$0`；fold 以 `costUsd !== undefined` 为准而非金额为正，因此免费调用的 token 同样离开未计费集合，而不是被套用配置费率。

## 备选方案

**按提供方的费率表。** 拒绝：OpenRouter preset 路由到账户所固定的任意模型，配置的费率表无法为它计价；响应元数据可以，而且它反映路由与折扣——费率表无从得知。

**读取 pi-ai 按 catalog 估算的 `usage.cost`。** 拒绝：手工声明的模型物化时费率为零，恰在本功能关键处取不到值；即便非零，它也仍是估算，与同一条线上的提供方计费事实相冲突。

**在补丁内用报告值覆盖 `usage.cost` 的计算值。** 拒绝：附加式的 `providerCost` 字段让所有既有 pi-ai 消费方的行为保持不变，补丁也保持为可上游化的小幅差异。

## 后果

混用两类提供方的会话读到的是实际账单加一份统一费率估算；该行的 `~` 前缀与 README 的“参考估算而非账单记录”措辞覆盖了这种混合。`tokenUsage` 的投影升到 `stateVersion: 2`，持久的 version-1 行在读取时重新折叠。pi-ai 升级时必须重新套用该补丁或将其上游化——已核实 0.84.4 仍会丢弃报告的费用。行为由包级单元测试（映射、fold 拆分、混合会话计价、检查点恢复）与一次真实 OpenRouter 探测（22 token 的 preset 调用返回 `providerCost=0.00038`）固定；web 快照通道没有费用行场景（本次改动之前就没有，且该通道在此检出上因无关原因在 loader 装配阶段失败），首个场景暂缓。
