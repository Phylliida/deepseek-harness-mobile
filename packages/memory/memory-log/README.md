# @deepseek-ai/dsh-memory-log

English | [中文](README.zh.md)

The log memory provider (`ctx.memory`): the [OptMem](https://github.com/VictorTaelin/OptMem) design as a harness service, byte-compatible with the upstream store. One fixed-width append-only `LOG.txt` holds every memory; a binary summary tree under `TREE/` is a rebuildable cache the agent itself compresses, one block at a time, through nap answers. Detail decays with age: wake renders recent memories verbatim and ancient ones as one-line summaries, within a configurable line budget. The store directory is created at load — pointing `directory` at a store IS the deliberate act of opening that identity.

Two routing commands wrap the dialogue so one agent keeps a memory per project: `projects` lists the immediate child directories of `projectsRoot` (marked with which holds a store and which is active), and `use <name>` switches the active store into the `projectsDir` inside that directory (`use global` switches back). A first selection physically creates the project's store.

## The command dialogue

`src/engine.ts` is the OptMem command dialogue over a `MemoryStore`, ported command for command from the reference `memo` CLI: `wake [part [T]]`, `note "<line>"`, `nap [lo-hi "<line>"]`, `recall <regex>`, `zoom <lo-hi>`, `forget <lo-hi>`, `import <file>`. The returned text is the seam's contract, including the `Run:` instructions naming the next command, which the agent sends back verbatim. Command words are split honoring single and double quotes; inside double quotes `\"` and `\\` escape, inside single quotes nothing does. `import` bulk-appends `YYYY-MM-DD <text>` lines and is bootstrap-only: dates must be real and non-decreasing, and the file must be UTF-8 text. Two upstream commands are deliberately absent: `init` (the provider creates its store at load, from Config) and `config` (cordis.yml owns the sizes; a store-level override would bypass the deployment).

Where upstream reports failure with exit 1 and stderr, this port throws `MemoryError`; the one exception is a blocked wake, whose text is the instruction the agent must read, so it returns normally. `nap` outcomes are the reply texts `<block> saved.`, `<block> is already settled.`, `<block> was settled or forgotten meanwhile.`, and `Nothing left to compress.`

## On-disk layout

| Path | Contents |
|---|---|
| `LOG.txt` | One 320-byte record per memory: `#i YYYY-MM-DD text` space-padded plus a newline. Append-only, never edited. |
| `TREE/<n>` | One 288-byte record per size-`n` block summary. Each level file is a dense prefix: its length says exactly how far that level got. |
| `LOG.txt.lock` | Cross-process writer mutex: a `wx`-created sibling from `dsh-atomic-write` that serializes every mutation, removed on release. |

Records are fixed width so position is identity: memory `i` lives at byte offset `i * 320`, block `[k*n, (k+1)*n)` at `k * 288` of `TREE/<n>`. Padding costs disk and buys O(1) seeks with no index to keep in sync. All operations are synchronous file I/O behind one async seam method: one `read` per rendered line, never a scan.

## Block math

A block is an aligned power-of-two range of memories, printed inclusive at both ends (`16-31`). `cover(T, wakeLines)` tiles `[0, T)` so a block stays whole iff its size is at most `alpha` times its age — detail decays with age, so recent memories stay verbatim while ancient ones collapse into single lines. When the log fits the budget uncompressed, nothing is compressed at all; leftover budget is spent splitting the newest block, where detail is worth most. Blocks of at most `RAW_MAX` (16) memories compress straight from the raw log; larger blocks compress from the summaries of their two halves. Blocks are built strictly in order, smallest first.

## Crash repair and locking

Every mutation holds the `LOG.txt.lock` writer lock, truncates a partial trailing record left by a crash (it was never acknowledged), appends, and `fsync`s before acknowledging. A summary that decodes with replacement characters fails the read with a `MemoryError` naming the forget repair; a store scan that finds a misaligned `LOG.txt` fails loud instead of guessing record boundaries. A writer that cannot take the lock within two seconds fails; a stale `LOG.txt.lock` left by a killed process blocks writers until removed by hand. The lock is deliberately NOT upstream's `.lock` file: flock and lockfiles cannot mutually exclude, and colliding on the name would deadlock every append against a store the Python tool ever touched — sharing one store across implementations is a sequential affair.

## Configuration

The sizes are reading and transport budgets, never storage: changing one never recomputes or touches a recorded memory.

| Key | Default | Semantics |
|---|---|---|
| `directory` | `memory/` under `$DSH_HOME` (else `~/.dsh`) | Store directory of the global memory; a leading `~` is expanded. Created at load. |
| `projectsRoot` | process working directory | Root whose immediate child directories count as projects for `projects`/`use`; a leading `~` is expanded. An explicitly configured root that does not exist fails at load. |
| `projectsDir` | `.memory` | Store directory created inside a selected project; one directory name, no separators — anything else fails at load. |
| `wakeLines` | `96` | How many lines one wake renders (96 ≈ 8k tokens of dense text). |
| `entryChars` | `280` | Longest one memory or summary line, in UTF-8 bytes; capped at 280 because an entry must fit both record kinds. |
| `partChars` | `20000` | Largest one output part, in UTF-8 bytes (harness truncation headroom). |
| `partLines` | `500` | Largest one output part, in lines. |

## OptMem attribution

The design — fixed-width append-only log, aligned power-of-two summary tree, agent-in-the-loop compression — comes from [OptMem](https://github.com/VictorTaelin/OptMem). The upstream repository carries no LICENSE, so this package is a clean-room TypeScript reimplementation: only the published algorithms and formats are reproduced, not the code. Record widths and limits follow upstream's measured values (320/288 bytes, 280-byte entries, `RAW_MAX` 16).

## Model Experience

Indirectly, through `dsh-tool-memory`, which passes the provider's dialogue text to the model verbatim as the `memory` tool's results.

#### KV Cache effect

No direct invalidation; the named Consumer owns all request-prefix and history changes. The store's own knobs are read budgets, so changing them alters future renderings without touching recorded memories.

## Known Limitations and Deferred Work

- **Regex-only recall** — `recall` is a case-insensitive regular expression over raw log lines; there is no semantic or embedding search.
- **Process-wide scope selection** — `use <name>` switches the active store on the one provider instance, so all sessions in one composition share the selection: parallel sessions selecting different stores race the in-memory field, and an app restart returns the selection to the global memory (single-user deployments are the target).
- **Sibling writer lock** — cross-process mutual exclusion waits two seconds, then errors; a stale `LOG.txt.lock` from a killed process blocks writers until removed by hand, and concurrent writers through the upstream Python tool are not excluded (flock and lockfiles do not interact).
- **No redaction or GC** — `LOG.txt` is append-only and never edited, so a recorded secret or stale fact stays on disk until the store directory is deleted; compression caps the read budget, not the storage.
