# memory/ — memory capability family

English | [中文](README.zh.md)

This family gives the agent a permanent, self-compressing memory that outlives every session: a provider-neutral command-dialogue service, one append-only-log provider, and the model-facing tool that consumes them.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Defines the permanent-memory service (`MemoryService.run(command)`) and `MemoryError` | `ctx.memory` |
| [`memory-log/`](memory-log/README.md) | Provides the OptMem-design append-only log plus rebuildable summary tree | implements `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Exposes the `memory` tool and the `tool:memory` prompt section to the model | registers on `ctx.tools` and `ctx.systemPrompt` |

Compression is agent-in-the-loop across the whole family: the provider never summarizes by itself, and the dialogue's `Run:` lines turn each due compression into the agent's next command. The design follows [OptMem](https://github.com/VictorTaelin/OptMem), reimplemented in clean-room TypeScript because upstream carries no license; the rationale for a native seam over MCP memory bridges is in the [memory seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md).

The subsystem reference — command grammar, store layout, block math, and the compression lifecycle — is [docs/subsystems/memory.md](../../docs/subsystems/memory.md).
