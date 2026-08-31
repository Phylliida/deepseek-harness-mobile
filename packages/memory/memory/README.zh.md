# @deepseek-ai/dsh-memory

[English](README.md) | 中文

**`MemoryService`**（`ctx.memory`）定义永久记忆是什么——agent（智能体）与一个比每一次会话、压缩（compaction）、模型和厂商变更都活得更久的存储之间进行的命令对话——而不规定如何存储。该 seam 精确遵循 [OptMem](https://github.com/VictorTaelin/OptMem) 接口：一边输入一个命令字符串，另一边输出 OptMem 对话文本。

本包承担记忆能力的 Service Definition 角色，各角色因此可以独立演进（和替换）：

| 包 | 职责 |
|---|---|
| `@deepseek-ai/dsh-memory`（本包） | Service Definition：抽象服务 + `MemoryError` |
| `@deepseek-ai/dsh-memory-log` | Service Provider：仅追加日志 + 摘要树，OptMem 设计 |
| `@deepseek-ai/dsh-tool-memory` | 基于 `ctx.memory`、面向模型的 `memory` 工具与提示词小节 |

该拆分是一个标准的能力 seam（[capability-seams Agent Note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)）；选择原生 seam 而非 MCP 记忆桥的理由见[记忆 seam Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md)。压缩由 agent 参与完成：提供方从不自行做摘要——它们在结果文本中提问，agent 用 `nap` 作答。

## 服务 API（`ctx.memory`）

`MemoryService` 只有一个抽象方法：`run(command)` 运行 OptMem 语法中的一个命令并返回其输出文本。空命令或纯空白命令返回用法文本；格式错误的命令或命名了存储中不存在之物的命令抛出 `MemoryError`。

| 命令 | 语义 |
|---|---|
| `wake [part [T]]` | 逐页读取记忆上下文，最旧在前，越靠近现在越细。`T` 是先前某页打印的日志长度快照，使多页读取不受并发 note 的影响。读取结束于显示 `You are awake.` 的一页；需要某个缺失摘要的页则改为返回需要先应答的压缩。 |
| `note "<line>"` | 记录一条记忆：一行有持久影响的文本，不超过提供方的字节上限。回复给出分配的 id，并携带该 note 触发的到期压缩（如有）。 |
| `nap [lo-hi "<line>"]` | 压缩入口。带块与摘要行时结算指定块——块严格按序构建，最小的优先；不带参数时报告下一个到期压缩。 |
| `recall <regex>` | 不区分大小写地搜索有史以来记录的每条记忆。返回能放进一个部分的最新匹配，以及全日志的匹配总数。 |
| `zoom <lo-hi>` | 把摘要树的一个节点展开为它的两半，直到原始记忆。 |
| `forget <lo-hi>` | 丢弃一个错误的摘要及建立在它之上的一切；下一次 `nap` 会重新计算它们。底层记忆从不动。 |

结果在 `Run:` 之后打印的任何一行都是要逐字发回的下一个命令。实现方子类化 `MemoryService` 并实现 `run`；一个组合在每个 context 中恰好加载一个提供方作为 `ctx.memory`。

## 文本即 seam

结果就是 agent 所读的确切文本，包括其中的指令（`Run:` 行、`You are awake.`、nap 请求）：在结果之外再组织额外行文属于分层违规。规范记录渲染是一条记忆写作 `#i YYYY-MM-DD text`、一个树节点写作 `#a-b summary`，块 id 两端均为闭区间（`16-31` 覆盖第 16 到 31 条记忆）。提供方对调用 agent 可以处理的失败抛出 `MemoryError`（绝不抛裸 `Error`）——超长行、拼错的块 id、损坏的摘要——以便 Consumer 原样呈现错误消息。

## 模型体验

通过 `dsh-tool-memory` 间接影响；该 Consumer 把 seam 的对话文本作为 `memory` 工具的结果传给模型，并持有 `tool:memory` 系统提示词小节。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀与历史的全部变更由具名 Consumer 负责。

## 已知限制与暂缓事项

- **压缩只能由 agent 参与完成**：seam 没有提供方侧或独立于模型的兜底摘要器；agent 始终不作答的压缩会让依赖它的块一直阻塞 wake。
- **服务层没有使用纪律**：wake 优先、只记持久事实、subagent 跳过等规则是 Consumer 的提示词文本；服务本身接受任何调用方以任何顺序发起的任何命令。
