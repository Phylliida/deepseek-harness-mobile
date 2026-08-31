# Memory

English | [中文](memory.zh.md)

The [memory capability family](../../packages/memory) gives the agent a permanent, self-compressing memory that outlives every session, compaction, model, and vendor change. It comprises the Service Definition ([dsh-memory](../../packages/memory/memory), `ctx.memory`), the append-only-log Service Provider ([dsh-memory-log](../../packages/memory/memory-log)), and the Consumer ([dsh-tool-memory](../../packages/memory/tool-memory)) with its `memory` tool and the `tool:memory` prompt section. The design follows [OptMem](https://github.com/VictorTaelin/OptMem): a fixed-width append-only log plus a binary summary tree that the agent itself compresses, reimplemented in clean-room TypeScript because the upstream repository carries no license. One provider opens the global store and, through two routing commands, one store per project inside the project's own directory. The seam's rationale over MCP memory bridges is in the [memory seam Agent Note](../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md).

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts), [`packages/memory/memory-log/src/index.ts`](../../packages/memory/memory-log/src/index.ts), [`packages/memory/memory-log/src/store.ts`](../../packages/memory/memory-log/src/store.ts), [`packages/memory/memory-log/src/engine.ts`](../../packages/memory/memory-log/src/engine.ts), [`packages/memory/tool-memory/src/index.ts`](../../packages/memory/tool-memory/src/index.ts), and [`packages/memory/tool-memory/src/prompt.ts`](../../packages/memory/tool-memory/src/prompt.ts).

## Seam contract

`ctx.memory` has one method: `run(command)` runs one command string in the OptMem grammar — `wake [part [T]]`, `note "<line>"`, `nap [lo-hi "<line>"]`, `recall <regex>`, `zoom <lo-hi>`, `forget <lo-hi>` — plus two provider-level routing commands, `projects` and `use`, that pick which store the grammar commands run against. It returns the dialogue text. The text IS the seam: results carry their own instructions, and any line a result prints after `Run:` is the next command to send, verbatim. An empty command returns the usage text; a malformed command or one naming something the store does not hold throws `MemoryError`, never a bare `Error`, so Consumers surface the message verbatim. Compression is agent-in-the-loop: providers never summarize by themselves — they ask, in the result text, and the agent answers with `nap`.

The canonical record rendering is `#i YYYY-MM-DD text` for one memory and `#a-b summary` for one tree node, with block ids inclusive at both ends (`16-31` covers memories 16 through 31).

## Store layout

The provider keeps one store directory holding `LOG.txt` (one 320-byte record per memory, `#i YYYY-MM-DD text` space-padded plus a newline, append-only and never edited), `TREE/<n>` (one 288-byte record per size-`n` block summary; each level file is a dense prefix, so its length says exactly how far that level got), and `LOG.txt.lock` (a cross-process writer mutex from `dsh-atomic-write`, a `wx`-created sibling removed on release, failing after two seconds of contention; deliberately not upstream's flock-based `.lock`, so one store can be shared with the Python tool sequentially). The global store lives in the configured `directory` and exists from load; two routing commands layer project stores over it — `projects` lists the immediate child directories of `projectsRoot` (default: the process working directory) marking which holds a store and which is active, and `use <name>` switches the active store into the `projectsDir` inside that project (default `.memory/`), created on first selection, with `use global` switching back. Selection is process-wide in-memory state, and every grammar command runs against the active store, so the dialogue inside each store is identical. Records are fixed width so position is identity: memory `i` lives at byte offset `i * 320`, block `[k*n, (k+1)*n)` at `k * 288` of `TREE/<n>`, which buys O(1) seeks with no index to keep in sync. All operations are synchronous file I/O behind one async seam method — one `read` per rendered line, never a scan.

## Blocks and decay

A block is an aligned power-of-two range of memories, printed inclusive at both ends. `cover(T, wakeLines)` tiles `[0, T)` keeping a block whole iff its size is at most `alpha` times its age, so detail decays with age: recent memories stay verbatim while ancient ones collapse into single summary lines. When the log fits the line budget uncompressed, nothing is compressed at all; leftover budget splits the newest block, where detail is worth most. Blocks of at most `RAW_MAX` (16) memories compress straight from the raw log; larger blocks compress from the summaries of their two halves, and blocks are built strictly in order, smallest first.

## Compression lifecycle

Each tree level file holds a dense prefix, so the due set is one `stat` per level, never a scan. `nap` settles blocks in that order, answering `<block> saved.`, `<block> is already settled.`, `<block> was settled or forgotten meanwhile.`, or `Nothing left to compress.` `forget` drops a summary and its dependents by truncating the level files back to that point; the log is never touched, so the next nap recomputes them. Crash safety comes from the append protocol: every mutation holds the lock, truncates a partial trailing record left by a crash (it was never acknowledged), and `fsync`s before acknowledging; a summary that decodes with replacement characters fails the read with a `MemoryError` naming the forget repair, and a misaligned `LOG.txt` fails loud instead of guessing record boundaries.

## Model-facing dialogue

`dsh-tool-memory` registers one tool, `memory(command: string)`, and injects the static `tool:memory` system-prompt section at order 105, early in the 100–199 tool-guidance band because it mandates startup behavior. The section is OptMem's upstream prompt template with two deliberate edits — the shell command becomes the tool's `command` string, and the note mandate names durable facts only — teaching the wake-first discipline, the durable-facts-only noting rule (never transient PR/CI state, which the session log and git already record), the store-first discipline for project versus global facts, and the subagent skip. Every call returns one text block: a wake page ends in a `Run:` footer naming the next command or in `You are awake.`, and a due compression embeds the exact answering `nap` command. The schema is generated into the [tool catalog](../tool-catalog.md#deepseek-aidsh-tool-memory); the package README quotes the prompt section verbatim.

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
