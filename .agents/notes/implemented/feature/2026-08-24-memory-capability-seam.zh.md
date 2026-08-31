# Agent Note：Memory capability seam（OptMem 设计）

状态：已实现

[English](2026-08-24-memory-capability-seam.md) | 中文

## 问题

Agent 没有永久记忆：它们学到的一切都随会话、压缩（compaction）或模型供应商的更换而消亡。harness 现有的答案——工作区文件、Agent Note、技能——记录的是如何工作，而不是决定了什么、尝试了什么、对用户了解到什么。[OptMem](https://github.com/VictorTaelin/OptMem) 证明了一个可行的最小设计：一段 426 token 的提示加一个零依赖脚本，建立在仅追加日志之上，并在多会话编码工作中测得了连续性收益。本次任务就是把该设计变成 harness 的一等能力。

## 决定

**是一条 capability seam，而不是粘贴一段提示。** `packages/memory/` 包含三个包：`dsh-memory`（`ctx.memory` 上的抽象 `MemoryService`）、`dsh-memory-log`（提供方）、`dsh-tool-memory`（Consumer：一个 `memory` 工具加 `tool:memory` 提示节）。挂载按 composition 选择启用；已发布的 bundle 与 preset 不改动。

**一个提供方，一个全局存储，N 个项目存储。** 提供方用两个路由命令包裹语法：`projects` 列出 `projectsRoot`（默认：进程工作目录）的直接子目录（标记哪个已有存储、哪个处于激活），`use <name>` 把激活存储切到该目录内的 `projectsDir`（默认 `.memory/`，首次选择时创建）；`use global` 切回。此后每个语法命令都作用于激活存储，因此每个存储内的 OptMem 对话逐字节一致。选择是进程级内存状态：同一 composition 内的所有会话共享它，应用重启则回到全局记忆。提示节新增先选存储的纪律——项目事实记入选中项目的记忆，用户级事实记入全局记忆。

**seam 的约定就是 OptMem 接口，逐字照搬。** `MemoryService.run(command: string): Promise<string>` 接收一条 OptMem 语法的命令字符串（`wake [part [T]]`、`note "..."`、`nap [lo-hi "..."]`、`recall <regex>`、`zoom <lo-hi>`、`forget <lo-hi>`、`import <file>`），返回上游打印的完全相同的对话文本，`Run:` 指令在内。单参数 `command` 的单工具 Consumer 因此适用于任何提供方；打印出的指令总能原样作为下一次调用发送；也不存在一套需要与文本保持同步的并行结构化 API。两个上游命令被有意略去：`init`（提供方依据 Config 在加载时创建存储）与 `config`（cordis.yml 拥有这些尺寸）。

**压缩由 agent 参与完成。** 提供方从不自行摘要；到期的块以 nap 请求的形式随 note 或 wake 的结果文本出现——原样引用来源、逐字打印应答用的 `Run: nap a-b "<your line>"` 行——模型用那条完全相同的命令字符串作答。这让记忆质量由理解工作的模型掌握，不产生任何后台 LLM 调用，并让每条摘要都能从会话日志重放（请求与应答都是普通的工具结果）。

**逐字节兼容的净室重实现，而非 vendoring。** 上游仓库没有 LICENSE 文件，因此 `dsh-memory-log` 复现其算法与格式——定长记录（位置即身份、O(1) 寻址）、对齐二次幂归并树、随年龄衰减的 `cover()` 铺砌、破损记录修复、稠密前缀层级文件、本地日期的 note 时间戳——而不复制其代码。记录宽度与上限沿用上流的实测值（320/288 字节、280 字节条目、`RAW_MAX` 16）。逐字节兼容由 `tests/fixtures/optmem-store/` 钉住：一个由上游 Python 工具生成、再由 TypeScript 移植版读回的存储（两个方向均已在开发中验证）。

**提示是调优过的，不是粘贴的。** 上游生成的提示让 agent 记录“任何值得认真投入的任务”，实际会写入瞬时的 PR/CI 状态（上游 issue #14：97.6% 的 note 正文含瞬时标记）。`MEMORY_PROMPT` 改为指明何为持久——偏好、带理由的决策、根因、授权边界——并明确排除 SHA、CI 结果与阻塞项，因为会话日志已经记录了它们。

**跨进程安全使用仓库自家的写入锁。** Node 没有 flock，因此变更通过 `dsh-atomic-write` 的 `withFileLock` 在 `LOG.txt` 上串行（`wx` 创建的 `LOG.txt.lock` 同级文件），像上游一样一个存储一把锁。该锁刻意不用上游的 `.lock` 文件：flock 与锁文件无法互斥，名字相撞反而会让任何追加在接触过 Python 工具的存储上死锁。两个实现共享一个存储只能顺序进行；跨实现的并发写入方不被排除，也不受支持。

## 考虑过的备选方案

**把 OptMem 提示块贴进 AGENTS.md 并 shell 调用 Python 脚本。** 否决：没有类型化接口、没有渲染意图、没有覆盖率门禁，还带上 mobile（Termux）组合不具备的 Python 运行时假设。工具同时对目录与文档门禁不可见。

**用薄 Consumer 包装 `memo` CLI。** 否决：把 Python 依赖与未授权的上游制品留在执行路径里，并为单次文件寻址通过 bash 工具沙箱做进程外调用。

**第三方 MCP 记忆桥。** `examples/mcp-memory/` 已经桥接了 Memorix、MCP Reference Memory server 与 Engram（[note](2026-07-31-third-party-memory-mcp-examples.md)）——全部默认关闭，全部是需要外部服务的向量／知识图谱存储。对本需求否决：它们用一个五文件的本地存储换来一个网络服务，且检索是嵌入相似度，而不是这条 seam 保证的可审计、可重放的摘要树。

**复数提供方注册表（`ctx.memories`，技能式）。** 否决：一个存储就是一个身份；挂载两个记忆提供方会分裂 agent 的过去。当前没有 Consumer 需要提供方扇出，单数抽象服务形态（compaction 先例）与之吻合。存储作用域改为落在唯一提供方内部：一个服务、一个激活存储，由 agent 通过路由命令选择——没有创建第二个服务名（`project-memory`）或第二个工具，因为 seam 的 `run(command)` 约定本就能承载任何命令字符串，路由不需要更多。

**六个类型化工具（`memory_wake`、`memory_note`……）或一个带结构化 `op` 联合的单工具。** 否决，选择最大程度的 CLI 保真：单个 `memory` 工具，其 `command` 字符串承载 OptMem 语法。逐命令的类型化 schema 能换来参数校验，但会让提示教给模型的接口与结果文本打印的接口分叉，每条 `Run:` 行都需要翻译而不是逐字发送。引号语法（双引号，含 `\"` 与 `\\` 转义）很小，已在工具 schema 中用示例教会。

**为记忆状态引入会话事件。** 否决：记忆按设计是机器作用域、跨会话存活的；工具调用与结果由中央记录，因此“模型可见 ⟺ 已记录”不变量在不需要 `memory/*` 事件族的情况下成立。

## 影响

agent 的记忆每次会话启动固定花费一段提示节加若干 wake 页（每页不超过 wakeLines 行，默认 96 ≈ 8k token），外加每条持久事实一次 note/nap 交换。seam 不新增事件，因此投影、session-query 与持久化不受影响。recall 仅支持正则——语义搜索需要同一约定下的另一个提供方。subagent 排除与 wake 优先纪律是提示级的，没有强制；行为不端的组合可以跳过 wake，存储只是不被读取。存储按设计无界增长（仅追加；压缩封顶的是读取预算，不是存储本身）。共享同一 composition 的并行会话之间可能存在存储选择竞争，对单用户部署而言可以接受；`projects`/`projectsDir` 的默认值（进程 cwd、`.memory`）把项目记忆放在工作区可见之处而非埋在 `/Users/danielleensign/.dsh` 中，这意味着项目存储随其所描述的项目目录一起移动。
