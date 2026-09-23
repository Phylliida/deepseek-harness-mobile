# @deepseek-ai/dsh-command-autobio

[English](README.md) | 中文

面向用户的 `/autobio` 控制命令，作用于[自传式压缩后端](../compaction-autobiographical/README.md)。该插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一个全局命令，因此组合中的每个命令适配器都能在无需模型轮次的情况下查看并切换该后端的自动折叠。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/autobio`、`/autobio status` | 报告自动折叠是否开启，以及当前状态对该会话意味着什么。 |
| `/autobio on` | 注册步骤边界的折叠流程；报告切换后所处的状态。 |
| `/autobio off` | 移除步骤边界的折叠流程；报告切换后所处的状态。 |
| `/autobio <其他任何内容>` | `Usage: /autobio [on|off|status]`：不改变状态。 |

参数会去除首尾空白并忽略大小写，因此 `/autobio OFF` 与 `/autobio  status ` 都会被接受。每次完成的调用都会记录执行器所属的纯日志事件对 `command/run` / `command/done`；两者都不进入模型历史。

该命令与具体后端绑定：它驱动 `AutobiographicalCompactionEngine`，当挂载的 `ctx.compaction` 提供方是其他后端时会报错，而不是假装切换了自己并不拥有的东西。关闭折叠会移除该引擎的步骤边界监听器，因此表层不再在轮次之间变化，也不会启动任何记忆形成调用。显式折叠不受影响：即使自动折叠处于关闭状态，`/compact` 以及任何其他 `compactNow()`／`compactIfNeeded()` 调用方仍然会折叠；命令落地时已在执行中的折叠流程也会完成其折叠，包括已经在运行的记忆形成调用。

该开关是运行时状态，而不是配置：重启后引擎会回到其自身配置中的 `auto` 取值。

## 组合

将后端与本插件挂载在命令注册表旁：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-autobiographical
  name: '@deepseek-ai/dsh-compaction-autobiographical'
- id: command-autobio
  name: '@deepseek-ai/dsh-command-autobio'
```

随附的 `dsh` 基础配置挂载的是 `/compact` 与 `compaction-basic`；选择启用自传式折叠的 profile 需要补上此后端行，并为了让对话能够控制它，再把本命令挂载在其旁。

## 模型体验

### 用户 `/autobio` 控制

#### 模型看到什么

斜杠输入与直接结果都不会进入模型请求：命令由 `ctx.commands` 分发，并在对话之外作答。关闭折叠确实会改变后续请求的内容——已折叠区间会保留替换后的回忆，并停止进一步粗化——但开关本身既不添加也不移除任何模型可见文本。

#### Token 影响

该命令不增加模型 token。它选择的状态会：自动折叠会从后续请求中移除每个被遮蔽区间的 token，并为每个被压缩分块花费一次记忆形成请求；因此关闭折叠会冻结表层的 token 开销，直到某个显式请求再次折叠。

#### KV Cache 影响

命令发现与簿记不会影响缓存。在折叠保持关闭期间，不会有折叠落地，后续请求会持续复用已预热的 prefix；重新开启会在下一轮的第一个被遮蔽节点处使复用失效，与后端自身的折叠行为完全一致。

## 已知限制与暂缓事项

- **仅支持一个后端**：命令会把 `ctx.compaction` 收窄为自传式引擎，并拒绝其他任何提供方，因此运行 `compaction-basic` 的部署会得到错误，而不是静默无操作。通用的引擎控制 seam 尚不存在。
- **作用于整个上下文，而非单个会话**：引擎是每个上下文一个服务，因此该开关覆盖该引擎服务的所有会话，而不只是发起调用的那一个。
- **状态不持久化**：开关存在于已加载的引擎实例中；会话日志中没有任何记录表明折叠曾被关闭，因此事后阅读日志的操作者只会看到折叠停止，却找不到记录下来的原因。
- **无法控制调度**：命令只能开关折叠；它不能按需请求一次折叠（那是 `/compact` 的职责），也不能在运行时调整窗口与阈值，这些仍只能通过配置修改。
