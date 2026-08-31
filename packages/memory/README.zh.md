# memory/：记忆能力家族

[English](README.md) | 中文

本家族为 agent（智能体）提供比每次会话更长寿、可自我压缩的永久记忆：一个与提供方无关的命令对话服务、一个仅追加日志提供方，以及消费它们的面向模型工具。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`memory/`](memory/README.md) | 定义永久记忆服务（`MemoryService.run(command)`）与 `MemoryError` | `ctx.memory` |
| [`memory-log/`](memory-log/README.md) | 提供 OptMem 设计的仅追加日志与可重建摘要树 | 实现 `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | 向模型公开 `memory` 工具与 `tool:memory` 提示词小节 | 注册到 `ctx.tools` 与 `ctx.systemPrompt` |

整个家族的压缩都由 agent 参与完成：提供方从不自行做摘要，对话中的 `Run:` 行把每个到期压缩变成 agent 的下一个命令。设计沿用 [OptMem](https://github.com/VictorTaelin/OptMem)，因上游没有许可证而以净室 TypeScript 重实现；选择原生 seam 而非 MCP 记忆桥的理由见[记忆 seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md)。

子系统参考——命令语法、存储布局、块数学与压缩生命周期——见 [docs/subsystems/memory.md](../../docs/subsystems/memory.md)。
