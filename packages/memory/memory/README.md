# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

The **`MemoryService`** (`ctx.memory`) defines WHAT a permanent memory is — a command dialogue the agent holds with a store that outlives every session, compaction, model, and vendor change — without saying HOW it is stored. The seam follows the [OptMem](https://github.com/VictorTaelin/OptMem) interface exactly: one command string in, the OptMem dialogue text out.

This package owns the Service Definition role of the memory capability, split so each role can evolve (and be swapped) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-memory` (this) | Service Definition: abstract service + `MemoryError` |
| `@deepseek-ai/dsh-memory-log` | Service Provider: append-only log + summary tree, OptMem design |
| `@deepseek-ai/dsh-tool-memory` | the model-facing `memory` tool and prompt section over `ctx.memory` |

The split is a standard capability seam ([capability-seams Agent Note](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)); the rationale for a native seam over the MCP memory bridges is in the [memory seam Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md). Compression is agent-in-the-loop: providers never summarize by themselves — they ask, in the result text, and the agent answers with `nap`.

## Service API (`ctx.memory`)

`MemoryService` has one abstract method: `run(command)` runs one command in the OptMem grammar and returns its output text. An empty or whitespace command returns the usage text; a malformed command or one naming something the store does not hold throws `MemoryError`.

| Command | Semantics |
|---|---|
| `wake [part [T]]` | Read the memory context page by page, oldest first, finest near the present. `T` is the log-length snapshot an earlier part printed, keeping a multi-page read stable against concurrent notes. The read ends at a page saying `You are awake.`; a page needing a missing summary instead returns the compression to answer first. |
| `note "<line>"` | Record one memory: one line of lasting effect, at most the provider's byte limit. The reply names the assigned id and carries the compression the note brought due, if any. |
| `nap [lo-hi "<line>"]` | Compression entry point. With a block and a summary line, settle that one block — blocks are built strictly in order, smallest first; without arguments, report the next due compression. |
| `recall <regex>` | Search every memory ever recorded, case-insensitively. Returns the newest matches that fit one part, plus the total across the log. |
| `zoom <lo-hi>` | Open one summary-tree node into its two halves, down to the raw memories. |
| `forget <lo-hi>` | Drop a wrong summary and everything built on top of it; the next `nap` recomputes them. The underlying memories are never touched. |

Any line a result prints after `Run:` is the next command to send, verbatim. Implementations subclass `MemoryService` and implement `run`; a composition loads exactly one provider per context as `ctx.memory`.

## The text IS the seam

Results are the exact text the agent reads, including its instructions (`Run:` lines, `You are awake.`, nap requests): composing additional prose around them is a layering violation. The canonical record rendering is `#i YYYY-MM-DD text` for one memory and `#a-b summary` for one tree node, with block ids inclusive at both ends (`16-31` covers memories 16 through 31). Providers throw `MemoryError` (never a bare `Error`) for failures the calling agent can act on — an over-long line, a mistyped block id, a corrupt summary — so Consumers surface the message verbatim.

## Model Experience

Indirectly, through `dsh-tool-memory`, which passes the seam's dialogue text to the model as the `memory` tool's results and owns the `tool:memory` system-prompt section.

#### KV Cache effect

No direct invalidation; the named Consumer owns all request-prefix and history changes.

## Known Limitations and Deferred Work

- **Compression is agent-in-the-loop only** — the seam defines no provider-side or model-independent fallback summarizer; a compression the agent never answers keeps wake blocked on the blocks that need it.
- **No service-level usage discipline** — wake-first, note-durable, and subagent-skip rules are Consumer prompt text; the service itself accepts any command in any order from any caller.
