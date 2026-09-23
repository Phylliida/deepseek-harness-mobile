# @deepseek-ai/dsh-compaction-autobiographical

[English](README.md) | 中文

**自传式压缩（compaction）后端**：`AutobiographicalCompactionEngine` 实现 `@deepseek-ai/dsh-compaction` Service Definition，由 Anima Connectome `@animalabs/context-manager` 的 `AutobiographicalStrategy` 驱动，持续进行分层记忆形成。与在 token 压力到来时压缩一次的 [`compaction-basic`](../compaction-basic/README.md) 不同，该后端在每个步骤边界把陈旧历史折叠（fold）为第一人称回忆，因此会话长度不受限制，折叠调度也以提示词 cache 稳定性为目标来规划。

本包承担压缩能力的 Service Provider 角色；其约定见 [Service Definition 包](../compaction/README.md)，设计见[后端 Agent Note](../../../.agents/notes/proposed/feature/2026-03-02-autobiographical-compaction-backend.md)。

## 拥有的职责

- **镜像**：每个会话在 `{storeRoot}/{sessionId}` 处拥有一份基于 Chronicle 存储的 `ContextManager`。以追加为来源的表层事件只回放一次，每条都盖上其会话日志 seq；存储重新打开时，回放水位（watermark）会从最新一条已镜像消息中恢复，因此重启不会重复摄取历史。替换节点——包括本后端自身的折叠——绝不会被回镜回策略。
- **工具 schema**：每轮折叠都会把会话已组装的工具 schema 推入归档，因为策略会推迟压缩任何包含工具块的分块，直到定义齐备为止；从未推送过它们的会话永远无法折叠带有工具记录的对话。
- **会话日志权威**：harness 日志始终是唯一事实来源。镜像只是用于规划的旁路；它唯一的输出就是落到表层上的折叠操作。
- **前沿规划**：`manager.compile(budget)` 在当前预算下解析出策略的上下文布局，`previewContext(budget, undefined, { render: true })` 则返回该布局实际会渲染的条目。因此规划是拿渲染结果做对账，而不是重新推导解析器会输出什么。
- **持续折叠**：在 `agent/pre-step` 阶段、派生请求之前，规划出的布局会与当前表层做差异比对，并作为一个带标记的事务落地。折叠不以压力为前提：`compactIfNeeded()` 忽略传入的触发原因，因为一段内容是否折叠取决于策略对它所处区间的分辨率判断。
- **记忆形成**：压缩调用在按会话串行化的 tick 链上运行，并通过 membrane 桥接层走 `ctx.llm.stream()`，因此凭证、路由、重试与用量记账都留在 harness 适配器侧。这些调用保留推理，但当响应的思考加正文的成本超过它所折叠的源片段时，桥接层只把正文交给库——库按存储的响应为折叠定价并回放，所以折叠的成本绝不应超过它所替代的内容。回忆始终由会话自身已路由的模型书写——自传式记忆是 agent 在书写自己的历史，换成别的模型就是策略会拒绝使用的替代声音。
- **记账**：seam 的 `compaction/start`、每次落地的折叠对应一条 `compaction/summary`，以及一条 `compaction/end`，三者携带同一个 `compactionId`。返回的 `CompactionResult` 聚合了全部已遮蔽 seq、作为 `summary` 的最后一条回忆，以及已遮蔽 token 估算的合计值。
- **识别**：后续轮次通过 `[Recall <id>]` 头识别折叠节点，并经由 `sourceEventSeqs` 展开其覆盖范围，因此无论在哪个层级反复折叠，覆盖范围比较都成立。
- **生命周期**：每个会话的运行时只打开一次并缓存；打开失败会被丢弃，以便下一轮重试；`agent/disposed` 会关闭存储，即使运行配置为 `auto: false` 也是如此。
- **运行时开关**：`setAutomaticFolding(false)` 会移除步骤边界监听器，因此无需卸载后端即可停止轮次之间的折叠；手动路径仍可正常工作，状态可通过 `isAutomaticFoldingEnabled` 读取。[命令包](../command-autobio/README.md)将它暴露为 `/autobio`。
- **空闲与手动路径**：`compactNow()` 在 `agent.runMaintenance` 内执行一次折叠；`compactRegion()` 会拒绝，因为区间是随其变旧而自动折叠，而不是按需折叠。
- **失败处理**：在自动路径上，会话尚未路由请求、上下文窗口未知，以及即使采用最粗分辨率也无法容纳的前沿，这三种情况都只发出警告，并让该轮的表层保持不变；手动调用则把同样的失败返回给调用方。折叠绝不阻塞轮次，提供方自身的溢出恢复仍是最终兜底路径。

## 配置（`AutobiographicalCompactionConfig`）

所有设置都可选；窗口尺寸默认为 connectome-host 为其 agent 发布的取值，其余策略旋钮原样透传给库，由库自身的默认值决定。会话存在 `cwd` 时，`storeRoot` 相对它解析，否则相对进程目录解析。计数值拒绝负值，`mergeThreshold` 至少为 `2`，`recentWindowTokens`、`targetChunkTokens` 与 `maxTokens` 至少为 `1`。

| Key | 必填 | 含义 |
|---|---|---|
| `storeRoot` | 否（默认 `.dsh/autobio`） | 每个会话的 Chronicle 存储的目录根。 |
| `contextWindowTokens` | 否（默认：已路由请求的窗口，上限 65536） | 覆盖适配器上报上下文窗口的编译预算上限；也是用小而刻意的预算检验折叠行为的调节杆。未设置时，以及在首个已路由请求之前，该轮会跳过。默认上限将工作点保持在约 64k——模型远在到达其标称窗口之前就会退化——而更小的已路由窗口始终优先。 |
| `reserveTokens` | 否（默认 `8192`） | 编译预算内为模型回复保留的 token。 |
| `recentWindowTokens` | 否（默认 `30000`） | 在任何折叠发生之前逐字保留的近期尾部。 |
| `headWindowTokens` | 否（默认 `4000`） | 会话起始处逐字保留的头部。 |
| `maxMessageTokens` | 否（默认 `10000`） | 库拆分前单条镜像消息的 token 上限。 |
| `targetChunkTokens` | 否（库默认 `3000`） | 单个 L1 回忆区块的近似大小。 |
| `mergeThreshold` | 否（库默认 `6`） | 多少个同级摘要合并为下一层级。 |
| `maxTokens` | 否（默认不设置） | 每次记忆形成调用固定使用的生成预算；不设置时采用策略自身的请求大小。长推理模型应调高它——推理与回忆正文共享这笔预算，若全部耗在推理上，调用会以 `max_tokens` 结束并使其区块进入隔离区。 |
| `foldingStrategy` | 否（默认 `kv-stable`） | 前沿规划策略：`kv-stable` 最小化提示词 cache 扰动，`flat-profile` 与 `oldest-first` 是库提供的另两种策略。 |
| `auto` | 否（默认 `true`） | 加载时注册步骤边界折叠 listener。设为 `false` 则仅手动折叠；也可以通过 `setAutomaticFolding` 或 [`/autobio`](../command-autobio/README.md) 在运行时切换该 listener。 |

该后端以自适应分辨率模式驱动策略，并自行掌握 tick 时机：`adaptiveResolution` 恒为开启，`autoTickOnNewMessage` 关闭以便由 harness 决定何时压缩，`summaryParticipant` 命名为 assistant。会话已路由的模型同时作为策略的 `compressionModel` 传入，因此回忆的声音始终是 agent 自己的声音，而不是库会拒绝用来书写记忆的替代模型。

## 用法

`AutobiographicalCompactionEngine` 注入 `ctx.llm` 与 `ctx.sessions`。以下组合从其宿主接收 `ctx.llm`，并安装引擎所需的会话存储：

```ts
import type { Context } from '@deepseek-ai/cordis'
import AutobiographicalCompactionEngine from '@deepseek-ai/dsh-compaction-autobiographical'
import SessionStore from '@deepseek-ai/dsh-session'

export const name = 'compaction-autobiographical'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.plugin(SessionStore)
  ctx.plugin(AutobiographicalCompactionEngine)
}
```

加载插件会注册 `ctx.compaction`。当 `auto: true`（默认）时，它会在每个步骤边界、派生请求之前折叠陈旧历史。同级 [`dsh-command-compact`](../command-compact/README.md) 调用 `ctx.compaction.compactNow(...)`，在该后端上可用；显式区间请求则不可用。同级 [`dsh-command-autobio`](../command-autobio/README.md) 可在运行时切换本后端的自动折叠。

```yaml
- name: '@deepseek-ai/dsh-compaction-autobiographical'
  config:
    storeRoot: .dsh/autobio
    recentWindowTokens: 120000
    targetChunkTokens: 6000
    foldingStrategy: kv-stable
```

## 模型体验

### 会话历史

#### 模型看到的内容

一次折叠会把一段陈旧的表层节点替换为一条 `assistant/message`，其文本是 agent 自己对那段经历的回忆，并以产生它的摘要 id 作为头部。逐字保留的近期尾部与（若配置了）被钉住的头部窗口保持原始状态，因此长会话的请求依次是头部、按时间顺序排列的回忆与仍以原始形态保留的区间、以及尾部。

##### 折叠节点文本

```markdown
[Recall L1-4]

I recall that we had been tracing the compaction seam, and that I had just finished reading the backend that summarizes under pressure. I had not yet decided how the fold schedule should treat the verbatim tail.
```

#### Token 影响

折叠会用回忆的 token 替换被遮蔽区间的计量 token，而后续合并又会用一条更粗的回忆替换若干条回忆，因此随着会话变长，表层在每单位历史上的成本持续下降，且从不携带第二份副本。折叠在派生请求之前运行，所以紧接着的下一个请求就已携带它；而即使采用最粗分辨率也无法容纳的区间，会让表层保持不变。`reserveTokens` 始终位于编译预算之外。

#### KV Cache 影响

折叠是替换，因此提供方的复用会从第一个被遮蔽节点起失效；该节点之前的前缀仍可复用。`foldingStrategy: 'kv-stable'` 通过规划布局来保持这一扰动较小；并且区间只会在进一步变粗时被重写——一个节点替换一个节点——因此表层绝不会把已折叠区间重新展开为原始轮次。

### 记忆形成请求

#### 模型看到的内容

记忆形成是针对单个陈旧区块的一次独立推理，框定为 agent 自己的回忆：先以 agent 自己的声音回放它先前的回忆，然后一条带内标记宣告即将压缩的片段，接着是该区块的消息，最后一条指令要求给出记忆本身。只有返回的散文会成为回忆。下方的标记与指令是 `@animalabs/context-manager` 库自身的文本，而非本包的文本；库升级可能改变它们。

##### 带内记忆形成标记

```markdown
System: You will soon form a new memory, get ready. The messages that follow are the slice of recent experience you are about to compress. After them, write the memory in your own voice.
```

##### 记忆形成指令（最后一条消息）

```markdown
Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Preserve concrete details — file paths, exact values, decisions, unresolved questions, the user's active asks. Target ~<targetTokens> tokens. Output only the memory body — no preamble, no section headers unless they help preservation, no meta-commentary about summarizing. Memorize only what actually happened in that slice: if it holds little beyond routine system traffic (heartbeats, empty turns, failure notices), a short memory saying so is correct — do not pad it by re-narrating events you already remember from earlier as if they had just happened again.
```

#### Token 影响

每条回忆都要支付一次受 `maxTokens` 限制的推理——每个被压缩的区块一次，每次合并到更粗层级再一次——其输入是已镜像的历史加上上述框定内容。压缩以串行 tick 每次处理一个区块；每个形成记忆的 tick 追加一条携带新铸回忆的 `autobio/memory` 事件，聊天界面按记忆形成调用各渲染一条状态行：调用进行中实时流出文本（`autobio/memory-progress` 冲刷），随后沉淀为新铸的回忆，点击可展开查看。当表层仍在预算内时 tick 在后台涓流推进；但当选择器找不到可行的布局时，轮次会等待：追赶 tick 在推理线程上运行，直到布局可行——只有当一个 tick 没有形成任何新记忆（没有可压缩内容）时，本次通过才会放手并保持表层不变。

#### KV Cache 影响

记忆形成请求不是会话请求：它自行组装消息列表，harness 的系统提示词与工具定义绝不会到达它。因此它既不读取也不使会话的热前缀失效，尽管它运行在会话所路由的同一个模型上。

## 已知限制与暂缓事项

- **`compactRegion` 未实现**：后端对显式区间请求抛出 `ManualCompactionError('summary')`，而不是折叠调用方指定的区间。区间随其变旧而折叠；`compactNow()` 是可用的手动路径。
- **已折叠区间的细化会被钳制**：一次 `assistant/message` 替换无法把区间重新拆成多个节点，因此当规划分辨率比表层已显示的更细时，较粗的回忆会保留。归档保留每个层级，原始记录也从未删除，但表层在每个区间上是单调的：已折叠区间不会回到原始形态。
- **折叠节点不是 seam 检查点**：回忆是一条携带 `[Recall <id>]` 的 `assistant/message`，而不是由 `compactCheckpointSource` 构建的 `user/message`。按消息来源识别压缩检查点的消费方无法识别回忆；模型会把回忆读作自己的过去，而不是读作已建立背景的检查点。
- **每次折叠只有一个节点**：一次折叠操作用恰好一个节点遮蔽一个区间，规划也从不让某个区间的节点数增长。若不展开区间就要细化它，就需要在单个折叠所处位置放置多个节点。
- **镜像是第二份存储**：回忆存放在 `storeRoot` 下按会话划分的 Chronicle 存储中。该存储丢失或被移动会丢弃已形成的记忆；日志会回放进一份全新的镜像，记忆形成从最旧的区块重新开始。
- **附件以占位符形式镜像**：镜像无法表示的块（图片、文档、音频）会变成 `[<type> omitted from memory mirror]` 文本占位符，因此回忆保留附件存在这一事实，但从不保留其载荷。
- **桥接层约定之外的摘要器请求字段会被丢弃**：桥接层转发 `messages`、`system`、生成上限与温度；库可能加到摘要请求上的工具声明不会传给 `ctx.llm.stream()`。
- **折叠可能跟不上快速增长的会话**：记忆形成是每个步骤一次压缩调用，且按会话串行化；若会话可折叠中段超出预算的速度快于这一节奏，就无法容纳任何布局：该轮会带 token 明细发出警告，并让表层保持不变，而不是只折叠一部分。预算、逐字尾部与摘要模型的速度共同决定部署有多少余量。
- **布局无法与表层对账时该轮会被跳过**：当所选布局与当前表层节点无法对齐时，规划不返回任何操作，下一步再重试。因此折叠成批落地而非每步落地；已经超出预算的会话会一直超出，直到某一轮对齐后落地。
