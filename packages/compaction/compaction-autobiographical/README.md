# @deepseek-ai/dsh-compaction-autobiographical

English | [中文](README.zh.md)

The **autobiographical compaction backend**: an `AutobiographicalCompactionEngine` implementing the `@deepseek-ai/dsh-compaction` Service Definition with continuous, hierarchical memory formation driven by the `AutobiographicalStrategy` of the Anima Connectome `@animalabs/context-manager`. Where [`compaction-basic`](../compaction-basic/README.md) compacts once when token pressure arrives, this backend folds aged history into first-person recollections at every step boundary, so session length is unbounded and the fold schedule is planned for prompt-cache stability.

This package owns the Service Provider role of the compaction capability — see the [Service Definition package](../compaction/README.md) for its contract and the [backend Agent Note](../../../.agents/notes/proposed/feature/2026-03-02-autobiographical-compaction-backend.md) for the design.

## What it owns

- **Mirror** — one per-session `ContextManager` over a Chronicle store at `{storeRoot}/{sessionId}`. Append-origin surface events replay into it once, each stamped with its session-log seq; the replay watermark recovers from the newest mirrored message when the store reopens, so a restart does not re-ingest history. Replacement nodes — including this backend's own folds — are never mirrored back.
- **Tool schemas** — each pass pushes the session's assembled tool schemas into the archive, because the strategy defers compressing any chunk that contains tool blocks until definitions are present; a session that never pushed them would never fold a tool-bearing transcript.
- **Session-log authority** — the harness log stays the single source of truth. The mirror is a planning sidecar; its only output is fold operations applied to the surface.
- **Frontier planning** — `manager.compile(budget)` resolves the strategy's context layout at the current budget, and `previewContext(budget, undefined, { render: true })` returns the entries that layout would actually render. Planning therefore reconciles against rendered text instead of re-deriving what the resolver would emit.
- **Continuous folding** — at `agent/pre-step`, before request derivation, the planned layout is diffed against the current surface and landed as one bracketed transaction. Folding is not gated on pressure: `compactIfNeeded()` ignores its trigger, because a chunk is folded when the strategy's resolution for its span says so.
- **Memory formation** — compression calls run on a serialized per-session tick chain and ride `ctx.llm.stream()` through a membrane bridge, so credentials, routing, retry, and usage accounting stay with the harness adapters. Reasoning stays on for those calls, but when a response's thinking plus text would cost more than the source span it folds, the bridge hands the library the text alone — the library prices and replays a fold at its stored response, so a fold must never cost more than what it replaces. Recollections are always written by the session's own routed model — autobiographical memory is the agent writing about its own history, so a different model would be a substitute voice the strategy refuses to write with.
- **Bookkeeping** — the seam's `compaction/start`, one `compaction/summary` per landed fold, and one `compaction/end`, all carrying the same `compactionId`. The returned `CompactionResult` aggregates every shadowed seq, the last recollection as `summary`, and the summed shadowed-token estimate.
- **Recognition** — a fold node is identified on later passes by its `[Recall <id>]` header, and its footprint expands through `sourceEventSeqs`, so coverage comparisons survive repeated folding at any level.
- **Lifecycle** — runtimes are opened once per session and cached; a failed open is dropped so the next pass retries, and `agent/disposed` closes the store, including for a run configured with `auto: false`.
- **Runtime toggle** — `setAutomaticFolding(false)` removes the step-boundary listener, so folding stops between turns without unloading the backend; the manual paths keep working, and the state is readable through `isAutomaticFoldingEnabled`. The [command package](../command-autobio/README.md) exposes it as `/autobio`.
- **Idle and manual paths** — `compactNow()` runs one fold pass inside `agent.runMaintenance`; `compactRegion()` rejects, because regions fold automatically as they age rather than on demand.
- **Failure handling** — on the automatic path, a session that has not routed a request yet, an unknown context window, and a frontier that cannot fit even at its coarsest resolution each warn and leave the surface unchanged for that pass; a manual call surfaces the same failures to its caller instead. A fold never blocks a turn, and the provider's own overflow recovery remains the terminal path.

## Config (`AutobiographicalCompactionConfig`)

Every setting is optional; the window sizes default to the values connectome-host ships for its agents, and every other strategy knob passes through to the library so its own defaults rule. `storeRoot` resolves against the session's `cwd` when the session has one, and against the process directory otherwise. Counts reject negative values, `mergeThreshold` requires at least `2`, and `recentWindowTokens`, `targetChunkTokens`, and `maxTokens` require at least `1`.

| Key | Required | Meaning |
|---|---|---|
| `storeRoot` | no (default `.dsh/autobio`) | Directory root for the per-session Chronicle stores. |
| `contextWindowTokens` | no (default: the routed request's window, capped at 65536) | Compile-budget ceiling overriding the adapter-reported context window; also the lever for exercising folding against a small deliberate budget. Without it, and before the first routed request, a pass skips. The default cap keeps the operating point near ~64k — models degrade well before their advertised window — while a smaller routed window always wins. |
| `contextWindowTokensByModel` | no (default: empty) | Per-model operating ceilings keyed by the session's routed model; beats the 65536 default cap, loses to a configured `contextWindowTokens`. |
| `reserveTokens` | no (default `8192`) | Tokens reserved for the model's response inside the compile budget. |
| `recentWindowTokens` | no (default `30000`) | Verbatim recent tail kept before anything folds. |
| `headWindowTokens` | no (default `4000`) | Verbatim head pinned at the start of the session. |
| `maxMessageTokens` | no (default `10000`) | Token ceiling for one mirrored message before the library splits it. |
| `targetChunkTokens` | no (library default `3000`) | Approximate size of one L1 recollection chunk. |
| `mergeThreshold` | no (library default `6`) | How many same-level summaries merge into the next level. |
| `maxTokens` | no (default unset) | Generation budget pinned on every memory-formation call; unset leaves the strategy's own request size. Raise it for long-reasoning models — thinking shares this budget with the recollection text, and a call that spends it all on reasoning ends `max_tokens` and quarantines its chunk. |
| `foldingStrategy` | no (default `kv-stable`) | Frontier-planning policy: `kv-stable` minimizes prompt-cache perturbation, with `flat-profile` and `oldest-first` as the library's other policies. |
| `auto` | no (default `true`) | Register the step-boundary folding listener at load. Set `false` for manual-only folding; the listener can also be switched at runtime through `setAutomaticFolding` or [`/autobio`](../command-autobio/README.md). |

The backend drives the strategy in adaptive-resolution mode with its own tick authority: `adaptiveResolution` is always on, `autoTickOnNewMessage` is off so the harness decides when compression runs, and `summaryParticipant` names the assistant. The session's routed model is handed to the strategy as its `compressionModel`, so the recollection voice is always the agent's own rather than a substitute the library would refuse to write memories with.

## Usage

`AutobiographicalCompactionEngine` injects `ctx.llm` and `ctx.sessions`. The composition below receives `ctx.llm` from its host and installs the session store the engine needs:

```ts
import type { Context } from '@deepseek-ai/cordis'
import AutobiographicalCompactionEngine from '@deepseek-ai/dsh-compaction-autobiographical'
import SessionStore from '@deepseek-ai/dsh-session'

export const name = 'compaction-autobiographical'
export const inject = ['llm']

export function apply(ctx: Context): void {
  ctx.plugin(SessionStore)
  ctx.plugin(AutobiographicalCompactionEngine)
}
```

Loading the plugin registers `ctx.compaction`. With `auto: true` (the default) it folds aged history at every step boundary before request derivation. The sibling [`dsh-command-compact`](../command-compact/README.md) calls `ctx.compaction.compactNow(...)` and works against this backend; an explicit region request does not. The sibling [`dsh-command-autobio`](../command-autobio/README.md) toggles this backend's automatic folding at runtime.

```yaml
- name: '@deepseek-ai/dsh-compaction-autobiographical'
  config:
    storeRoot: .dsh/autobio
    recentWindowTokens: 120000
    targetChunkTokens: 6000
    foldingStrategy: kv-stable
```

## Model Experience

### Conversation history

#### What the model sees

A fold replaces an aged span of surface nodes with one `assistant/message` whose text is the agent's own recollection of that span, headed by the summary id that produced it. The verbatim recent tail and any pinned head window stay raw, so a long session's request is head, then recollections and surviving raw regions in chronological order, then the tail.

##### Fold node text

```markdown
[Recall L1-4]

I recall that we had been tracing the compaction seam, and that I had just finished reading the backend that summarizes under pressure. I had not yet decided how the fold schedule should treat the verbatim tail.
```

#### Token effect

A fold replaces the shadowed span's measured tokens with the recollection's, and a later merge replaces several recollections with a coarser one, so the surface's cost per unit of history falls as the session ages without ever carrying a second copy. Folding runs before request derivation, so the very next request already carries it, and a span that cannot fit even at the coarsest resolution leaves the surface unchanged. `reserveTokens` stays outside the compile budget.

#### KV Cache effect

A fold is a replace, so provider reuse is invalidated from the first shadowed node; the prefix before it stays reusable. `foldingStrategy: 'kv-stable'` plans the layout to keep that perturbation small, and a region is rewritten only when it coarsens further — one node replacing one node — so the surface never re-expands a folded region into raw turns.

### Memory formation request

#### What the model sees

Memory formation is a separate inference over one aged chunk, framed as the agent's own remembering: the agent's earlier recollections replay first as its own voice, then an in-band marker announces the slice about to be compressed, then the chunk's messages follow, and a final instruction asks for the memory itself. Only the returned prose becomes a recollection. The marker and instruction below are the `@animalabs/context-manager` library's own text, not this package's; a library upgrade can change them.

##### In-band memory-formation marker

```markdown
System: You will soon form a new memory, get ready. The messages that follow are the slice of recent experience you are about to compress. After them, write the memory in your own voice.
```

##### Memory-formation instruction (final message)

```markdown
Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Preserve concrete details — file paths, exact values, decisions, unresolved questions, the user's active asks. Target ~<targetTokens> tokens. Output only the memory body — no preamble, no section headers unless they help preservation, no meta-commentary about summarizing. Memorize only what actually happened in that slice: if it holds little beyond routine system traffic (heartbeats, empty turns, failure notices), a short memory saying so is correct — do not pad it by re-narrating events you already remember from earlier as if they had just happened again.
```

#### Token effect

Each recollection costs one inference capped by `maxTokens` — one per compressed chunk, plus one per merge into a coarser level — and its input is the mirrored history plus the framing above. Compression runs one chunk per serialized tick; each tick that forms memory appends an `autobio/memory` event carrying the minted recollection, which the chat renders as one status row per memory-formation call: the row streams the in-flight call's text (`autobio/memory-progress` flushes), then settles into the minted recollection, disclosed on click. Ticks trickle in the background while the surface fits its budget, but when the picker finds no fitting layout the turn waits: catch-up ticks run on the inference thread until a layout fits, and a tick that forms nothing new (nothing left to compress) ends the wait. Even then the fully-folded floor can exceed the budget while the pyramid is mid-formation — shallow layers awaiting merge packs — so the pass retries once at the measured floor and lands the best layout there rather than stranding the session raw; only when even that yields no layout does the pass leave the surface unchanged.

#### KV Cache effect

The memory-formation request is not the conversation request: it assembles its own message list, and the harness's system prompt and tool definitions never reach it. It therefore neither reads nor invalidates the conversation's warm prefix, even though it runs on the same model the session is routed to.

## Known Limitations and Deferred Work

- **`compactRegion` is unimplemented** — the backend rejects an explicit region request with `ManualCompactionError('summary')` rather than folding a caller-chosen span. Regions fold as they age; `compactNow()` is the manual path that works.
- **Refinement of a folded span is clamped** — one `assistant/message` replace cannot split a span back into several nodes, so when the planned resolution is finer than what the surface already shows, the coarser recollection stays. The archive keeps every level and the raw records are never deleted, but the live view is monotone per region: a folded span does not return to raw.
- **Fold nodes are not seam checkpoints** — a recollection is an `assistant/message` carrying `[Recall <id>]` instead of the `user/message` built from `compactCheckpointSource`. Consumers that recognize a compaction checkpoint by its message source do not recognize a recollection, and the model reads it as its own past rather than as an established-background checkpoint.
- **One node per fold** — a fold op shadows a span with exactly one node, and planning never grows a region's node count. Several nodes where one fold stands would be needed to refine a region without unfolding it.
- **The mirror is a second store** — recollections live in the per-session Chronicle store under `storeRoot`. Losing or moving that store discards the formed memories; the log replays into a fresh mirror and memory formation restarts from the oldest chunks.
- **Attachments are mirrored as placeholders** — blocks the mirror cannot represent (images, documents, audio) become a `[<type> omitted from memory mirror]` text placeholder, so a recollection preserves the fact of an attachment but never its payload.
- **Summarizer request fields beyond the bridge's contract are dropped** — the bridge forwards `messages`, `system`, the generation cap, and temperature; tool declarations the library may add to a summarization request are not passed to `ctx.llm.stream()`.
- **Folding can lag a fast-growing session** — memory formation is one compression call per step, serialized per session, so a session whose foldable middle outgrows its budget faster than that cannot fit any layout: the pass warns with the token breakdown and leaves the surface unchanged instead of folding part of the way. The budget, the verbatim tail, and the summarizer's speed decide how much headroom a deployment has.
- **A pass whose layout cannot be reconciled with the surface is skipped** — planning returns nothing when the selected layout does not line up with the current surface nodes, and the next step retries. Folding therefore lands in bursts rather than every step, and a session that is already over budget stays over budget until an aligned pass lands.
