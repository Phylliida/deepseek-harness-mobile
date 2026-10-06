# @deepseek-ai/dsh-compaction-autobiographical

[English](README.md) | 中文

**自传式压缩（compaction）后端**：`AutobiographicalCompactionEngine` 实现 `@deepseek-ai/dsh-compaction` Service Definition，由 Anima Connectome `@animalabs/context-manager` 的 `AutobiographicalStrategy` 驱动，持续进行分层记忆形成。与在 token 压力到来时压缩一次的 [`compaction-basic`](../compaction-basic/README.md) 不同，该后端在每个步骤边界把陈旧历史折叠（fold）为第一人称回忆，因此会话长度不受限制，折叠调度也以提示词 cache 稳定性为目标来规划。

本包承担压缩能力的 Service Provider 角色；其约定见 [Service Definition 包](../compaction/README.md)，设计见[后端 Agent Note](../../../.agents/notes/implemented/feature/2026-03-02-autobiographical-compaction-backend.md)。

## 日志即归档

不存在旁路存储。每个会话的 `ContextManager` 运行在内存 `JsStore` 之上，运行时打开时从会话日志播种（seed），而折叠是它唯一的写入：

- **回放**：日志中每个以追加为来源的事件都会成为 `messages` 槽位中的一条记录，并携带其 `dshSeq`。替换节点——本后端自身的折叠、修剪器节点——绝不回放，因此策略会针对折叠所代表的原始内容重新规划，并发现该区间已被覆盖。一次回放因此不会重新铸出上一轮已折叠的任何内容。
- **记忆回放**：每条 `autobio/memory` 事件都会成为一条 `SummaryEntry`。回忆无法被推导出来（铸出回忆需要调用模型），因此事件载荷*就是*它的持久记录：正文、层级，以及它覆盖的 seq 区间。
- **折叠节点**：回忆的文本也以替换其区间的 `assistant/message` 形式留在会话日志中，其 `compactionId`（`autobio:<summaryId>`）指明了它所代表的回忆。

由于两半都从日志回放，重启、崩溃或分叉都不产生任何推理开销：分叉的子会话从自己的日志播种，并继承父会话写下的每一条回忆。

## 拥有的职责

- **会话日志权威**：harness 日志始终是唯一事实来源。存储只是每次打开时重建的临时规划结构；它唯一的输出就是落到表层上的折叠操作。
- **工具 schema 与系统声音**：每一轮都会把会话已组装的工具 schema 及其系统提示推入存储，且只在首次见到它们的该轮推送；因为策略会推迟压缩任何包含工具块的分块，直到定义齐备为止，而只有提示已就位，记忆书写调用才会拿到会话的系统声音；从未推送过它们的会话永远无法折叠带有工具记录的对话。
- **前沿规划**：`manager.compile(budget)` 在当前预算下解析出策略的上下文布局，并提交选择器对每条消息的分辨率。随后该轮按“站在这些消息之上的回忆”对已解析消息做划分，每条回忆产出一个折叠操作，携带该折叠所替换的表层区间。规划读取的是已提交的分辨率；没有任何环节把渲染出的预览解析回布局。
- **持续折叠**：在 `agent/pre-step` 阶段、派生请求之前，每个已提交的操作都作为自己的带标记事务落地。折叠不以压力为前提：当策略对该区间的分辨率判定应当折叠时，回忆就会落地，因此 `compactIfNeeded()` 无论拿到什么触发原因都执行同一个折叠轮。它的标记区间由日志保持打开的那个轮次持有，因为该入口没有提出步骤。
- **记忆形成**：压缩调用在按会话串行化的 tick 链上运行，并通过 membrane 桥接层走 `ctx.llm.stream()`，因此凭证、路由、重试与用量记账都留在 harness 适配器侧。这些调用保留推理，但当响应的思考加正文的成本超过它所折叠的源片段时，桥接层只把正文交给库——库按存储的响应为折叠定价并回放，所以折叠的成本绝不应超过它所替代的内容。回忆始终由会话自身已路由的模型书写——自传式记忆是 agent 在书写自己的历史，换成别的模型就是策略会拒绝使用的替代声音。
- **记账**：seam 的 `compaction/start`、每次落地的折叠对应一条 `compaction/summary`，以及一条 `compaction/end`。每个操作占用一个标记区间，因为协议只允许在 start 与其 end 之间出现一条 summary：一次通过会落地编译所提交的每个操作，因此折叠两个区域就是两个事务，这也正是让每个标记区间以自己的 `compactionId` 承载该折叠身份的原因。
- **识别**：后续轮次通过该 `compactionId` 识别折叠节点，因此无需再从散文里解析回来；在该约定落地之前写下的折叠仍可从其 `[Recall <id>]` 头部恢复。
- **生命周期**：每个会话的运行时只打开一次并缓存；打开失败会被丢弃，以便下一轮重试；`session/disposed` 会丢弃该运行时。生命周期属于会话而不是某个 agent，因为选择器的状态——分辨率、回执、校准——只存在于运行时的内存里，而 agent 会在会话之内更替；如果在 `agent/disposed` 时丢弃，下一轮就不得不从零重新决策所有这些状态。无论哪种情况，删除映射项就是回收的全部内容——种子存储是映射持有的内存，而不是需要关闭的产物。
- **空闲与手动路径**：`compactNow()` 在 `agent.runMaintenance` 内执行一次折叠；`compactRegion()` 会拒绝，因为区间是随其变旧而自动折叠，而不是按需折叠。
- **失败处理**：在自动路径上，会话尚未路由请求、上下文窗口未知，以及保留量使运行窗口之下再无空间，这三种情况都让该轮的表层保持不变、不落地折叠；而即使按策略实际能达到的规模也无法容纳的前沿，会被报告出来并在下一步重试。手动调用则把同样的失败返回给调用方。折叠绝不阻塞轮次，提供方自身的溢出恢复仍是最终兜底路径。

## 配置（`AutobiographicalCompactionConfig`）

所有设置都可选。三个 harness 旋钮就是全部集成面；所有策略旋钮都放在 `strategy` 包里，原样交给 `AutobiographicalStrategy`，这样上游选项随库版本演进，而不必在这里逐字段镜像。`reserveTokens` 大到吃掉整个窗口时，该轮会跳过，而不会以非正预算去编译。

| Key | 必填 | 含义 |
|---|---|---|
| `operatingWindowTokens` | 否（默认 `65536`） | 该轮编译所依据的窗口：在线上下文被保持在 `min(已路由窗口, 此值) − reserveTokens` 之下，靠折叠陈旧历史达成。也是用小而刻意的预算检验折叠行为的调节杆。配置的值本身就是上限，因此更小的已路由窗口仍然优先，而更大的窗口不会抬高它。在首个已路由请求之前，该轮会跳过。默认值将工作点保持在约 64k——模型远在到达其标称窗口之前就会退化。 |
| `reserveTokens` | 否（默认 `8192`） | 为模型回复保留、不进入在线上下文的 token。该轮已经减过一次，库的预算算术随后再减一次，因此在线上限等于窗口减去该值的两倍——这份余量同时也覆盖策略看不到的系统提示与工具 schema。 |
| `auto` | 否（默认 `true`） | 加载时注册步骤边界折叠 listener。设为 `false` 则仅手动折叠。 |
| `strategy` | 否（默认 `{}`） | 透传给库的 `AutobiographicalOptions`：`recentWindowTokens`、`headWindowTokens`、`maxMessageTokens`、`targetChunkTokens`、`mergeThreshold`、`maxTokens`、`kvStableReachTokens`、`summaryTargetTokens` 等。 |

该后端以自适应分辨率模式驱动策略，并自行掌握 tick 时机：`adaptiveResolution` 恒为开启，`autoTickOnNewMessage` 关闭以便由 harness 决定何时压缩，`summaryParticipant` 命名为 assistant。会话已路由的模型同时作为策略的 `compressionModel` 传入，因此回忆的声音始终是 agent 自己的声音，而不是库会拒绝用来书写记忆的替代模型。

## 用法

`AutobiographicalCompactionEngine` 注入 `ctx.llm`。以下组合从其宿主接收 `ctx.llm`，并安装引擎所需的会话存储：

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

加载插件会注册 `ctx.compaction`。当 `auto: true`（默认）时，它会在每个步骤边界、派生请求之前折叠陈旧历史。同级 [`dsh-command-compact`](../command-compact/README.md) 调用 `ctx.compaction.compactNow(...)`，在该后端上可用；显式区间请求则不可用。

```yaml
- name: '@deepseek-ai/dsh-compaction-autobiographical'
  config:
    operatingWindowTokens: 65536
    strategy:
      recentWindowTokens: 120000
      targetChunkTokens: 6000
```

## 模型体验

### 会话历史

#### 模型看到的内容

一次折叠会把一段陈旧的表层节点替换为一条 `assistant/message`，其文本是 agent 自己对那段经历的回忆。逐字保留的近期尾部与被钉住的头部窗口保持原始状态，因此长会话的请求依次是头部、按时间顺序排列的回忆与仍以原始形态保留的区间、以及尾部。库返回了已存储响应的回忆会原样回放该响应；没有的则以摘要 id 作为头部、后接正文，见下方的折叠节点文本。

##### 折叠节点文本

```markdown
[Recall L1-4]

I recall that we had been tracing the compaction seam, and that I had just finished reading the backend that summarizes under pressure. I had not yet decided how the fold schedule should treat the verbatim tail.
```
#### Token 影响

折叠会用回忆的 token 替换被遮蔽区间的计量 token，而后续合并又会用一条更粗的回忆替换若干条回忆，因此随着会话变长，表层在每单位历史上的成本持续下降，且从不携带第二份副本。折叠在派生请求之前运行，所以紧接着的下一个请求就已携带它。`reserveTokens` 会被两次排除在在线上下文之外：该轮在运行窗口之下先减去一次，库随后又作为回复余量再减一次。

#### KV Cache 影响

折叠是替换，因此提供方的复用会从第一个被遮蔽节点起失效；该节点之前的前缀仍可复用。`kv-stable` 折叠策略通过规划布局来保持这一扰动较小；并且区间只会在进一步变粗时被重写——一个节点替换一个节点——因此表层绝不会把已折叠区间重新展开为原始轮次。

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

每条回忆花费一次推理，上限由策略的 `maxTokens` 决定——每个被压缩的分块一次，再加上每次合并到更粗层级的一次——其输入是回放的历史加上上文的框定文本。压缩按串行化的 tick 每次处理一个分块。每个有新消息的 tick 都会追加一条 `autobio/memory` 事件，携带铸出的回忆及其覆盖的 seq 区间、策略的计数器，以及本轮已结算调用由提供方上报的用量；会话的 tokenUsage 投影会把这些计入成本估算——记忆形成是真实支出，估算把它纳入其中。调用在形成过程中流式输出的文本，会以携带同一 attempt 的 `autobio/memory-progress` 记录追加在 tick 记录旁边，因此聊天界面为每次调用渲染一行：调用运行期间固定展示那段流式文本，回忆落地后披露它，调用以错误结束时标记为失败。tick 记录本身仍是归档所在，后续回放据此重建金字塔。tick 在按会话串行化的链上后台运行，轮次从不等待它们，因此缓慢的压缩调用延迟的是下一个 tick，而不是请求。tick 在该轮尝试编译之后才被唤起，被拒绝时也一样：策略在布局选择内部裁剪自己的压缩队列，所以早于会话首次编译的 tick 只会看到空队列、什么也形成不了——而被拒绝的会话必须持续形成记忆，否则它的下限永远不会改善。当没有任何布局能容纳时，该轮会按策略实际达到的规模重试一次；第二次拒绝会被报告出来，表层保持不变，由下一步重试。

#### KV Cache 影响

折叠是替换，因此提供方的复用会从第一个被遮蔽节点起失效；该节点之前的前缀仍可复用。`kv-stable` 折叠策略通过规划布局来保持这一扰动较小；并且区间只会在进一步变粗时被重写——一个节点替换一个节点——因此表层绝不会把已折叠区间重新展开为原始轮次。

## 已知限制与暂缓事项

- **`compactRegion` 未实现**：后端对显式区间请求抛出 `ManualCompactionError('summary')`，而不是折叠调用方指定的区间。区间随其变旧而折叠；`compactNow()` 是可用的手动路径。
- **地面已被折叠掉的回忆不会再次宣告**：铸出回忆时会记录它在铸出时所替换的表层 seq。若 tick 上报时这些 seq 在已回放的存储中不再解析，该次铸出会在本轮跳过并在之后重新审视，因此表层折叠途中记录的覆盖区间可能跨重启丢失。折叠节点仍然成立并仍然替换其区间；丢失的只是金字塔条目的覆盖引用。
- **已折叠区间的细化会被钳制**：一次 `assistant/message` 替换无法把区间重新拆成多个节点，因此当规划分辨率比表层已显示的更细时，较粗的回忆会保留。回放保留每个层级，原始记录也从未删除，但实时视图在每个区间上是单调的：已折叠区间不会回到原始形态。
- **折叠节点不是 seam 检查点**：回忆是一条携带其 `compactionId` 的 `assistant/message`，而不是由 `compactCheckpointSource` 构建的 `user/message`。按消息来源识别压缩检查点的消费方无法识别回忆；模型会把回忆读作自己的过去，而不是读作已建立背景的检查点。
- **每次折叠只有一个节点**：一次折叠操作用恰好一个节点遮蔽一个区间，规划也从不让某个区间的节点数增长。若不展开区间就要细化它，就需要在单个折叠所处位置放置多个节点。
- **附件以占位符形式回放**：存储无法表示的块（图片、文档、音频）会变成 `[<type> omitted from memory mirror]` 文本占位符，因此回忆保留附件存在这一事实，但从不保留其载荷。
- **桥接层约定之外的摘要器请求字段会被丢弃**：桥接层转发 `messages`、`system`、生成上限、温度，以及摘要请求携带的工具声明；库可能加入的其他字段不会传给 `ctx.llm.stream()`。
- **折叠可能跟不上快速增长的会话**：记忆形成是每个步骤一次压缩调用，且按会话串行化；若会话可折叠中段超出预算的速度快于这一节奏，就无法容纳任何布局：该轮会带 token 明细发出警告，并让表层保持不变，而不是只折叠一部分。预算、逐字尾部与摘要模型的速度共同决定部署有多少余量。
- **比布局更粗的表层保持不动**：当选择器为某区域规划的分辨率细于已落地的折叠（预算增大、金字塔加深）时，规划保留较粗的节点并丢弃较细的条目——更粗的折叠只会让上下文比计划更小，而一次替换无法拆分已有节点。范围仅仅起始落在某个更粗节点之内的折叠会绕过该节点——节点保留头部，新折叠从下一个表层节点开始遮蔽。并非严格更粗的分歧会从该轮抛出，该轮发出警告并在下一步重试，而不是落地一个与表层相矛盾的规划。因此折叠成批落地而非每步落地；已经超出预算的会话会一直超出，直到某一轮对齐后落地。
- **折叠绝不把工具调用与其结果拆开**：规划会加宽每次折叠的区间，直到每个被遮蔽的调用连同其结果一起被遮蔽：向后覆盖回答区间内某个调用的那一段结果，直到声明该调用的节点，向前则在区间仍在等待结果时继续。遍历会在另一个操作已占用的节点处停止——这正是把该操作自己的轮次留给它的原因——也会在声明了区间并不回应的调用的节点处停止。
