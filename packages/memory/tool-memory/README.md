# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

The model-facing `memory` tool over `ctx.memory`: one command string in, the OptMem dialogue text out — the whole seam speaks through it. This package owns the tool schema, the command grammar guidance, and the system-prompt section teaching the wake-first / note-durable / subagent-skip discipline; it never touches storage. The tool is a thin pass-through by design: the provider's result text already IS the model-facing answer, `Run:` lines included.

## The `memory` tool

One tool, `memory(command: string)`, runs one command in the memory grammar: `wake` (the mandated first call of every session, before any other work), `note "<one durable line>"`, `nap [lo-hi "<summary>"]` (answers due compressions), `recall <regex>`, `zoom <lo-hi>`, `forget <lo-hi>`, plus the bootstrap-only `import <file>`. The model is told to do exactly what the result prints; any line after `Run:` is the next command string, sent verbatim. Arguments containing spaces are double-quoted; `\"` and `\\` escape inside double quotes.

## Prompt discipline

The `tool:memory` section is injected at order 105 — early in the 100–199 tool-guidance band, because it mandates startup behavior and so precedes per-tool usage guidance. `MEMORY_PROMPT` is OptMem's upstream prompt template with two deliberate edits: the `{memo}` shell command becomes the tool's `command` string, and the note mandate names durable facts only (upstream's "a task worth real effort" wording fills the log with transient PR/CI status; [upstream issue #14](https://github.com/VictorTaelin/OptMem/issues/14)). Everything else tracks upstream so the printed dialogue and this prompt stay in lockstep. The three rules: wake first, on every session; note only what has lasting effect — never PR/issue numbers, commit SHAs, CI results, test counts, review progress, or current blockers, which the session log and git already record; subagents never run the memory tool, because a subagent cannot judge what is already known and its notes would arrive duplicated.

## Rendering

Every call returns one model-facing text block holding the provider's dialogue text. `presentCall` reports a generic card titled `memory <verb>` (the first word of the command) with the full command as raw input, kind `other`. The tool emits no session events of its own — calls and results are logged centrally by the tool runtime.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`memory` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-memory) — one required `command` string with the grammar examples in its description — on every request where the plugin is mounted.

#### Token effect

Fixed schema cost for one tool on every request where it is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### System prompt section

#### What the model sees

One static section named `tool:memory` in the system prompt. The text is fixed — it never varies per session, provider, or store state:

##### The `tool:memory` section text

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

#### Token effect

A fixed ≈500-token section in every system prompt while the plugin is enabled.

#### KV Cache effect

Static, prefix-stable text: it joins the reusable request prefix and changes only when this package's own wording changes.

### Tool results and the compression dialogue

#### What the model sees

Every result is the provider's dialogue text: a wake page ends in `Not awake yet. Run: wake <part> <T>` or in `You are awake.`; `note` answers `Saved as #<id>.`; a due compression embeds `Compress memories #<block> into one line of at most 280 bytes.` plus the `Run: nap <block> "<your line>"` instruction; `recall` and `forget` end in match and drop counts.

#### Token effect

A full wake prints up to `wakeLines` lines (default 96 ≈ 8k tokens of dense text) across one or more parts, and each `note` reply can carry a compression request plus its answering `nap` exchange. Every result is retained in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Prompt-level subagent restriction** — nothing in the tool layer refuses a subagent's `memory` call; the skip rule is instructed in the prompt, not enforced.
- **Prompt-level wake-first discipline** — no automatic wake happens at session start; the model must choose `wake` as its first command.
- **All-or-nothing enablement** — the tool and the prompt section mount as one plugin; there is no way to take the command surface without the discipline text that teaches it.
