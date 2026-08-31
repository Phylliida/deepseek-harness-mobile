# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

基于 `ctx.memory` 的面向模型 `memory` 工具：一边输入一个命令字符串，另一边输出 OptMem 对话文本——整个 seam 都通过它说话。本包负责工具 schema、命令语法指引和教授 wake 优先／只记持久事实／subagent 跳过纪律的系统提示词小节；它从不触碰存储。该工具有意做成薄的直通层：提供方的结果文本本身就是面向模型的答案，包括 `Run:` 行。

## `memory` 工具

一个工具 `memory(command: string)` 运行记忆语法中的一个命令：`wake`（每个会话被强制要求的第一个调用，先于任何其他工作）、`note "<one durable line>"`、`nap [lo-hi "<summary>"]`（应答到期压缩）、`recall <regex>`、`zoom <lo-hi>`、`forget <lo-hi>`，外加仅用于引导导入的 `import <file>`。模型被告知严格按结果打印的内容执行；`Run:` 之后的任何一行都是下一个命令字符串，逐字发送。含空格的参数用双引号括起；双引号内 `\"` 与 `\\` 转义。

## 提示词纪律

`tool:memory` 小节以 order 105 注入——位于 100–199 工具指导区段的靠前位置，因为它规定启动行为，因此先于各工具的使用指引。`MEMORY_PROMPT` 是 OptMem 上游提示词模板加上两处有意的修改：`{memo}` shell 命令变为本工具的 `command` 字符串，note 强制条款只命名持久事实（上游 "a task worth real effort" 的措辞会让日志充满瞬态 PR/CI 状态；[上游 issue #14](https://github.com/VictorTaelin/OptMem/issues/14)）。其余部分跟踪上游，使打印出的对话与本提示词保持一致。三条规则：每个会话都先 wake；只记录有持久影响的内容——绝不记录 PR／issue 号、提交 SHA、CI 结果、测试计数、评审进度或当前阻塞项，会话日志和 git 已经记录了它们；subagent 从不运行 memory 工具，因为 subagent 无法判断哪些内容已知，它的笔记会以重复的方式到达。

## 渲染

每次调用返回一个面向模型的文本块，内容即提供方的对话文本。`presentCall` 报告一张通用卡片，标题为 `memory <动词>`（命令的第一个词），完整命令作为原始输入，kind 为 `other`。该工具不发出自己的会话事件——调用与结果由工具运行时集中记录。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型在插件被挂载的每个请求上看到生成的 [`memory` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory)——一个必填的 `command` 字符串，其描述中带有语法示例。

#### Token 影响

工具可见的每个请求都有一个工具的固定 schema token 开销。

#### KV Cache 影响

只要定义和可见性不变，前缀就保持稳定。插件生命周期或 scope 限制可能会使从此 schema 起的缓存复用失效。

### 系统提示词小节

#### 模型看到的内容

系统提示词中一个名为 `tool:memory` 的静态小节。文本固定——绝不随会话、提供方或存储状态变化：

##### `tool:memory` 小节文本

```markdown
## Memory

Your memory is the memory tool:
- Send one command string per call, e.g. { "command": "wake" }
- Your memories live on disk, managed by the tool

Memory outlives every session, compaction, model and vendor change.
Without it you do not know who you are, or what was decided and tried.

### At startup: activating your memory (mandatory)

Call the memory tool with { "command": "wake" } before any other tool call, in every session, and then do exactly what it prints, to the end of its output.

### While working: register memories (mandatory)

Call the memory tool with { "command": "note \"<1 line, max 280 bytes>\"" } whenever you learn something of lasting effect: a durable user preference or fact about their life, an architectural decision and its rationale, a hard-won root cause, an explicit authorization boundary the user set.

Do NOT note transient state: PR/issue numbers, commit SHAs, CI results, test counts, review progress, current blockers — the session log and git already record those. Do not register redundant memories.

If a reply asks a compression: do it before your next action — send the printed Run: line verbatim as the next command string.

Never edit or delete anything under the memory directory: the tool manages it.

### When you need an old memory: search, or navigate

{ "command": "recall <regex>" } searches every memory, word for word.

Your memories also form a binary tree: #0-1, #2-3 ... exist as one-line summaries, pairs of those as #0-3, and so on -- every `#a-b` line wake prints is one node of it. { "command": "zoom <a-b>" } opens a node into its two halves, down to the raw memories.

### If you're a subagent: skip everything above

Parallel sessions on this machine are all you, and may all write memories. A subagent is not: it must never run the memory tool, because it cannot judge what is already known, and its notes would arrive duplicated and incorrectly. When you spawn one, write: `You are a subagent. Don't run the memory tool.`
```

#### Token 影响

插件启用期间，每个系统提示词中固定约 500 token 的小节。

#### KV Cache 影响

静态、前缀稳定的文本：它并入可复用的请求前缀，只有在本包自身措辞变化时才会改变。

### 工具结果与压缩对话

#### 模型看到的内容

每个结果都是提供方的对话文本：wake 页以 `Not awake yet. Run: wake <part> <T>` 或 `You are awake.` 结尾；`note` 回答 `Saved as #<id>.`；到期压缩会嵌入 `Compress memories #<block> into one line of at most 280 bytes.` 以及 `Run: nap <block> "<your line>"` 指令；`recall` 与 `forget` 以匹配数和丢弃数结尾。

#### Token 影响

一次完整 wake 在一个或多个部分中打印至多 `wakeLines` 行（默认 96 ≈ 8k token 的稠密文本），每次 `note` 回复都可能携带一个压缩请求及其应答 `nap` 往来。每个结果都会保留在历史中，直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **subagent 限制仅是提示词层面**：工具层没有任何东西拒绝 subagent 的 `memory` 调用；跳过规则靠提示词指示，不做强制。
- **wake 优先纪律仅是提示词层面**：会话开始时不存在自动 wake；模型必须自己选择以 `wake` 作为第一个命令。
- **启用是全有或全无**：工具与提示词小节作为一个插件挂载；没有办法只要命令接口而不要教授它的纪律文本。
