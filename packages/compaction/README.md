# compaction/ — compaction capability family

English | [中文](README.zh.md)

A compaction capability family (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): a Service Definition, two summarizing providers, a model-free tool-result pruning companion, and two human command Consumers. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| [`compaction/`](compaction/README.md) | Compaction seam and event vocabulary | `ctx.compaction` |
| [`compaction-basic/`](compaction-basic/README.md) | Token-pressure and summarization backend | registers `ctx.compaction` |
| [`compaction-autobiographical/`](compaction-autobiographical/README.md) | Continuous autobiographical-memory folding backend | registers `ctx.compaction` |
| [`compaction-tool-result-pruner/`](compaction-tool-result-pruner/README.md) | Optional model-free tool-result pruning | `ctx.toolResultPruner` |
| [`command-compact/`](command-compact/README.md) | Human compaction command | registers on `ctx.commands` |
| [`command-autobio/`](command-autobio/README.md) | Human toggle for the autobiographical backend's folding | registers on `ctx.commands` |

The backends, optional pruner, and human command compose through the seam; token measurement remains a separate LLM-family service. The [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md) owns the dependency rationale.

The subsystem reference — the `compaction/*` events, `CompactionResult`, the service, pruning outcomes — is [docs/subsystems/compaction.md](../../docs/subsystems/compaction.md); the seam's deliberate `dsh-session`/`dsh-llm` dependency is recorded in the [compaction capability-seam Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).
