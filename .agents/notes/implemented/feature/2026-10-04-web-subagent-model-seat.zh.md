# Agent Note: Web 对话输入区的会话级子代理模型选择

Status: implemented

[English](2026-10-04-web-subagent-model-seat.md) | 中文

## 问题

从 Web 会话发起的委派，默认在会话自身模型上启动子代理，除非发起方模型在每次调用时显式传入 `agentOptions` 路由。如果用户希望子代理统一使用更便宜或更强的模型，此前没有会话级的一次性表达方式：[会话模型选择器](2026-07-24-web-session-model-selector.md)改变的是父级自身的路由，而工具参数必须在每次委派时重复给出。

## 决策

Web Host 在会话选择旁保存一项会话级子代理路由覆盖。`session.models` 以 `subagent` 字段（`ModelSelection` 或 null）报告它，`session.selectSubagentModel` 负责设置或清除：provider 与 model 必须同时提供，并经由 `resolveCallConfig` 校验；两者都缺席则清除覆盖。与会话选择的进程内层级一样，该覆盖仅保存在当前进程中；图像准入检查不适用，因为子代理会启动自己的会话。

该覆盖通过 Agent 作用域上的 holder 传递到委派路径。Host 为每个 Web Agent 以 `ctx.subagentModel` 提供可变的 `SubagentModelOverride`，`@deepseek-ai/dsh-subagent` 的 `resolveChildRoute` 以机会主义方式读取它，按字段介于显式的单次请求覆盖与父级自身路由之间。没有该入口的部署保持父级继承行为。可持续（continuable）启动的描述符记录同一份已解析路由，因此子代理实际采用的路由始终可以从其子会话日志重建。该覆盖不携带推理强度，因为 `AgentOptions` 没有相应字段。

在浏览器中，composer seat（`conversation.input.model`）在会话模型触发器左侧渲染一个子代理模型触发器，两者共用同一个会话级 `ModelDirectory`。其单层菜单提供一行"跟随会话模型"——默认值，选中即清除覆盖——以及共享的按提供方分组目录，并通过目录的 `selectSubagent` 动词提交。可被寻址的子代理会话不暴露该 seat 与动词，理由与会话选择条目相同。

## 考虑过的替代方案

**把覆盖持久化为会话事件或设置值。** 尚未被任何委派采用的覆盖不会进入模型上下文，而委派启动的子代理会在自己的描述符与请求头中记录已解析路由。这与选择器"未使用的 UI 意图不产生持久事件"的立场一致。

**给 `session.selectModel` 增加目标字段。** 一个方法会混入两套配对与清除规则不同的 payload；独立方法让可空选择的语义和 provider／model 配对校验各自留在自己的 schema 上。

**在配置中提供部署级子代理默认值。** 全局默认值会同时改向所有会话的子代理。会话级 seat 遵循选择器的"会话优先于全局"规则，部署仍然可以通过组合（composition）固定路由。

## 影响

Web 会话可以一次性把其委派的子代理指向任何可服务的 provider／model 路由，而委派请求中的显式路由仍按字段优先。清除覆盖会恢复父级继承，且不影响会话选择本身。该覆盖在 Host 重启后不再保留；恢复后的会话回到父级继承，直到再次使用 seat。

## 测试

Host 测试锁定设置／报告／清除的往返、不可服务路由的拒绝，以及委派 seam 读取的 holder。子代理单元测试锁定路由层级以及不变的 maxTokens／深度行为。客户端测试锁定目录经 seat face 的往返、跟随行、未公布模型的回退标签，以及对可寻址子代理会话的隐藏。
