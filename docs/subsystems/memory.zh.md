# 记忆

[English](memory.md) | 中文

[记忆能力家族](../../packages/memory)为 agent（智能体）提供永久、可自我压缩的记忆，它比每一次会话、压缩（compaction）、模型和厂商变更都活得更久。家族由 Service Definition（[dsh-memory](../../packages/memory/memory)，`ctx.memory`）、仅追加日志 Service Provider（[dsh-memory-log](../../packages/memory/memory-log)）和 Consumer（[dsh-tool-memory](../../packages/memory/tool-memory)，含 `memory` 工具与 `tool:memory` 提示词小节）组成。设计沿用 [OptMem](https://github.com/VictorTaelin/OptMem)：定长仅追加日志加上由 agent 自己压缩的二叉摘要树，因上游仓库没有许可证而以净室 TypeScript 重实现。一个提供方打开全局存储，并通过两个路由命令在每个项目自己的目录内维护各项目的存储。选择该 seam 而非 MCP 记忆桥的理由见[记忆 seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md)。

源码：[`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)、[`packages/memory/memory-log/src/index.ts`](../../packages/memory/memory-log/src/index.ts)、[`packages/memory/memory-log/src/store.ts`](../../packages/memory/memory-log/src/store.ts)、[`packages/memory/memory-log/src/engine.ts`](../../packages/memory/memory-log/src/engine.ts)、[`packages/memory/tool-memory/src/index.ts`](../../packages/memory/tool-memory/src/index.ts)、[`packages/memory/tool-memory/src/prompt.ts`](../../packages/memory/tool-memory/src/prompt.ts)。

## seam 约定

`ctx.memory` 只有一个方法：`run(command)` 运行 OptMem 语法中的一个命令字符串——`wake [part [T]]`、`note "<line>"`、`nap [lo-hi "<line>"]`、`recall <regex>`、`zoom <lo-hi>`、`forget <lo-hi>`——再加上两个提供方级路由命令 `projects` 与 `use`，用于选择语法命令作用于哪个存储，并返回对话文本。文本即 seam：结果自带指令，结果在 `Run:` 之后打印的任何一行都是要逐字发回的下一个命令。空命令返回用法文本；格式错误的命令或命名了存储中不存在之物的命令抛出 `MemoryError`，绝不抛裸 `Error`，以便 Consumer 原样呈现错误消息。压缩由 agent 参与完成：提供方从不自行做摘要——它们在结果文本中提问，agent 用 `nap` 作答。

规范记录渲染是一条记忆写作 `#i YYYY-MM-DD text`、一个树节点写作 `#a-b summary`，块 id 两端均为闭区间（`16-31` 覆盖第 16 到 31 条记忆）。

## 存储布局

提供方维护一个存储目录，内含 `LOG.txt`（每条记忆一条 320 字节记录，`#i YYYY-MM-DD text` 空格补齐加换行，仅追加且从不编辑）、`TREE/<n>`（每个大小为 `n` 的块摘要一条 288 字节记录；每个层级文件都是稠密前缀，其长度精确说明该层级推进到哪里）和 `LOG.txt.lock`（来自 `dsh-atomic-write` 的跨进程写入互斥锁，`wx` 创建式同级文件，释放时删除，争用两秒后失败；刻意不用上游基于 flock 的 `.lock`，因此一个存储可以与 Python 工具顺序共享）。全局存储位于配置的 `directory` 中，自加载起存在；两个路由命令在其上叠加项目存储——`projects` 列出 `projectsRoot`（默认：进程工作目录）的直接子目录并标记哪个已有存储、哪个处于激活，`use <name>` 把激活存储切到该项目内的 `projectsDir`（默认 `.memory/`，首次选择时创建），`use global` 切回。选择是进程级内存状态，每个语法命令都作用于激活存储，因此每个存储内的对话完全一致。记录定长，因此位置即身份：记忆 `i` 位于字节偏移 `i * 320`，块 `[k*n, (k+1)*n)` 位于 `TREE/<n>` 的 `k * 288`，这换来 O(1) 寻址且无需维护索引。所有操作都是单个异步 seam 方法之后的同步文件 I/O——每渲染一行一次 `read`，从不全扫。

## 块与衰减

块是一段对齐的二次幂记忆区间，打印时两端均为闭区间。`cover(T, wakeLines)` 对 `[0, T)` 做铺砌，一个块保持完整当且仅当其大小不超过 `alpha` 乘以其年龄，因此细节随年龄衰减：近期记忆保持原文，远古记忆折叠为单行摘要。如果日志未压缩就能放进行数预算，则完全不压缩；剩余预算拆分最新的块，那里的细节最有价值。不超过 `RAW_MAX`（16）条记忆的块直接从原始日志压缩；更大的块由其两半的摘要压缩，且块严格按序构建，最小的优先。

## 压缩生命周期

每个树层级文件都是稠密前缀，因此到期集合的判定是每层级一次 `stat`，从不全扫。`nap` 按该顺序结算块，回复 `<block> saved.`、`<block> is already settled.`、`<block> was settled or forgotten meanwhile.` 或 `Nothing left to compress.`。`forget` 通过把层级文件截断回该点来丢弃一个摘要及其依赖项；日志从不动，因此下一次 nap 会重新计算它们。崩溃安全来自追加协议：每次变更都持有锁，截断崩溃留下的尾部残缺记录（它从未被确认），并在确认前 `fsync`；解码出替换字符的摘要会让读取以指明 forget 修复的 `MemoryError` 失败，未按记录对齐的 `LOG.txt` 会明确报错，而不是猜测记录边界。

## 面向模型的对话

`dsh-tool-memory` 注册一个工具 `memory(command: string)`，并以 order 105 注入静态的 `tool:memory` 系统提示词小节，位于 100–199 工具指导区段的靠前位置，因为它规定启动行为。该小节是 OptMem 上游提示词模板加上两处有意的修改——shell 命令变为本工具的 `command` 字符串，note 强制条款只命名持久事实——教授 wake 优先纪律、只记持久事实的规则（绝不记瞬态 PR/CI 状态，会话日志和 git 已经记录了它们）、项目事实与全局事实先选存储的纪律，以及 subagent 跳过。每次调用返回一个文本块：wake 页以指明下一个命令的 `Run:` 页脚或 `You are awake.` 结尾，到期压缩会嵌入选定确切应答 `nap` 命令的指令。schema 生成进[工具目录](../tool-catalog.md#deepseek-aidsh-tool-memory)；包 README 逐字引用提示词小节。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice-abstract-seam"></a>

### `ctx.memory` — `MemoryService` (abstract seam)

Abstract permanent-memory service; load one implementation per context as `ctx.memory`. The contract is the OptMem dialogue: results are the exact text the agent reads, including its instructions (`Run:` lines, "You are awake.", nap requests). Composing additional prose around results is a layering violation — the text IS the seam.

```ts cordis-catalog
/**
 * Run one memory command.
 *
 * @param command - one command in the OptMem grammar, e.g. `wake`,
 *   `wake 2 296`, `note "one line"`, `nap 0-1 "summary"`, `recall foo|bar`,
 *   `zoom 16-31`, `forget 16-31`. An empty or whitespace command returns the
 *   usage text.
 * @returns the command's output text.
 * @throws {MemoryError} when the command is malformed or names something the
 *   store does not hold.
 */
abstract run(command: string): Promise<string>
```

Source: [`packages/memory/memory/src/index.ts:40`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
