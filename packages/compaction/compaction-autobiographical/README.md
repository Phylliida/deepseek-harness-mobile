# @deepseek-ai/dsh-compaction-autobiographical

English | [中文](README.zh.md)

The **autobiographical compaction backend**: an `AutobiographicalCompactionEngine` implementing the `@deepseek-ai/dsh-compaction` Service Definition with continuous, hierarchical memory formation driven by the `AutobiographicalStrategy` of the Anima Connectome `@animalabs/context-manager`. Where [`compaction-basic`](../compaction-basic/README.md) compacts once when token pressure arrives, this backend folds aged history into first-person recollections at every step boundary, so session length is unbounded and the fold schedule is planned for prompt-cache stability.

This package owns the Service Provider role of the compaction capability — see the [Service Definition package](../compaction/README.md) for its contract and the [backend Agent Note](../../../.agents/notes/implemented/feature/2026-03-02-autobiographical-compaction-backend.md) for the design.

## The log is the archive

There is no sidecar store. A per-session `ContextManager` runs over an in-memory `JsStore` seeded from the session log when the runtime opens, and folds are its only writes:

- **Replay** — every append-origin event in the log becomes a `messages` slot entry carrying its `dshSeq`. Replacement nodes — this backend's own folds, pruner nodes — are never replayed, so the strategy replans over the originals a fold stands for and finds that ground already covered. A replay therefore re-mints nothing a previous run folded.
- **Memory replay** — every `autobio/memory` event becomes a `SummaryEntry`. A recollection cannot be derived (minting calls a model), so the event payload *is* the durable record of it: content, level, and the seq range it covered.
- **The fold node** — a recollection's text also lives in the session log as the `assistant/message` that replaced its span, and its `compactionId` (`autobio:<summaryId>`) names the recollection it stands for.

Because both halves replay from the log, a restart, a crash, or a fork costs zero inference: the child of a fork seeds from its own log and inherits every recollection its parent had written down.

## What it owns

- **Session-log authority** — the harness log stays the single source of truth. The store is a scratch planning structure rebuilt on every open; its only output is fold operations applied to the surface.
- **Tool schemas** — each pass pushes the session's assembled tool schemas into the store, because the strategy defers compressing any chunk that contains tool blocks until definitions are present; a session that never pushed them would never fold a tool-bearing transcript.
- **Frontier planning** — `manager.compile(budget)` resolves the strategy's context layout at the current budget, and `previewContext(budget, undefined, { render: true })` returns the entries that layout would actually render. Planning therefore reconciles against rendered text instead of re-deriving what the resolver would emit.
- **Continuous folding** — at `agent/pre-step`, before request derivation, the planned layout is diffed against the current surface and landed as bracketed transactions. Folding is not gated on pressure: `compactIfNeeded()` ignores its trigger, because a chunk is folded when the strategy's resolution for its span says so.
- **Memory formation** — compression calls run on a serialized per-session tick chain and ride `ctx.llm.stream()` through a membrane bridge, so credentials, routing, retry, and usage accounting stay with the harness adapters. Reasoning stays on for those calls, but when a response's thinking plus text would cost more than the source span it folds, the bridge hands the library the text alone — the library prices and replays a fold at its stored response, so a fold must never cost more than what it replaces. Recollections are always written by the session's own routed model — autobiographical memory is the agent writing about its own history, so a different model would be a substitute voice the strategy refuses to write with.
- **Bookkeeping** — the seam's `compaction/start`, one `compaction/summary` per landed fold, and one `compaction/end`. One fold per bracket, because the protocol allows exactly one summary between a start and its end; a pass that folds two regions lands two transactions, which is also what lets each bracket carry the fold's own identity as its `compactionId`.
- **Recognition** — a fold node is identified on later passes by that `compactionId`, so nothing parses the prose back out; a fold written before that convention landed is still recovered from its `[Recall <id>]` header.
- **Lifecycle** — runtimes are opened once per session and cached; a failed open is dropped so the next pass retries, and `agent/disposed` drops the runtime, which is the whole of disposal because the seeded store is memory the map was holding rather than an artifact to close.
- **Idle and manual paths** — `compactNow()` runs one fold pass inside `agent.runMaintenance`; `compactRegion()` rejects, because regions fold automatically as they age rather than on demand.
- **Failure handling** — on the automatic path, a session that has not routed a request yet, an unknown context window, and a frontier that cannot fit even at its coarsest resolution each warn and leave the surface unchanged for that pass; a manual call surfaces the same failures to its caller instead. A fold never blocks a turn, and the provider's own overflow recovery remains the terminal path.

## Config (`AutobiographicalCompactionConfig`)

Every setting is optional. The three harness knobs are the whole integration surface; every strategy knob lives in the `strategy` bag, which is handed to `AutobiographicalStrategy` untouched so upstream options flow with the library version instead of being mirrored here field by field. A `reserveTokens` large enough to consume the whole window makes the pass skip rather than compile against a non-positive budget.

| Key | Required | Meaning |
|---|---|---|
| `operatingWindowTokens` | no (default: the routed request's window, capped at 65536) | Ceiling for the live context the strategy keeps; also the lever for exercising folding against a small deliberate budget. Without it, and before the first routed request, a pass skips. The cap keeps the operating point near 64k — models degrade well before their advertised window — while a smaller routed window always wins. |
| `reserveTokens` | no (default `8192`) | Tokens reserved for the model's response inside the compile budget. |
| `auto` | no (default `true`) | Register the step-boundary folding listener at load. Set `false` for manual-only folding. |
| `strategy` | no (default `{}`) | `AutobiographicalOptions` passed through to the library: `recentWindowTokens`, `headWindowTokens`, `maxMessageTokens`, `targetChunkTokens`, `mergeThreshold`, `maxTokens`, `kvStableReachTokens`, `summaryTargetTokens`, … |

The backend drives the strategy in adaptive-resolution mode with its own tick authority: `adaptiveResolution` is always on, `autoTickOnNewMessage` is off so the harness decides when compression runs, and `summaryParticipant` names the assistant. The session's routed model is handed to the strategy as its `compressionModel`, so the recollection voice is always the agent's own rather than a substitute the library would refuse to write memories with.

## Usage

`AutobiographicalCompactionEngine` injects `ctx.llm`. The composition below receives `ctx.llm` from its host and installs the session store the engine needs:

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

Loading the plugin registers `ctx.compaction`. With `auto: true` (the default) it folds aged history at every step boundary before request derivation. The sibling [`dsh-command-compact`](../command-compact/README.md) calls `ctx.compaction.compactNow(...)` and works against this backend; an explicit region request does not.

```yaml
- name: '@deepseek-ai/dsh-compaction-autobiographical'
  config:
    operatingWindowTokens: 65536
    strategy:
      recentWindowTokens: 120000
      targetChunkTokens: 6000
```

## Model Experience

### Conversation history

#### What the model sees

A fold replaces an aged span of surface nodes with one `assistant/message` whose text is the agent's own recollection of that span. The verbatim recent tail and any pinned head window stay raw, so a long session's request is head, then recollections and surviving raw regions in chronological order, then the tail. A recollection the library returned with a stored response replays that response verbatim; one without replays the summary id as a header followed by the prose, under the fold node text below.

##### Fold node text

```markdown
[Recall L1-4]

I recall that we had been tracing the compaction seam, and that I had just finished reading the backend that summarizes under pressure. I had not yet decided how the fold schedule should treat the verbatim tail.
```

#### Token effect

A fold replaces the shadowed span's measured tokens with the recollection's, and a later merge replaces several recollections with a coarser one, so the surface's cost per unit of history falls as the session ages without ever carrying a second copy. Folding runs before request derivation, so the very next request already carries it, and a span that cannot fit even at the coarsest resolution leaves the surface unchanged. `reserveTokens` stays outside the compile budget.

#### KV Cache effect

A fold is a replace, so provider reuse is invalidated from the first shadowed node; the prefix before it stays reusable. The `kv-stable` folding strategy plans the layout to keep that perturbation small, and a region is rewritten only when it coarsens further — one node replacing one node — so the surface never re-expands a folded region into raw turns.

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

Each recollection costs one inference capped by the strategy's `maxTokens` — one per compressed chunk, plus one per merge into a coarser level — and its input is the replayed history plus the framing above. Compression runs one chunk per serialized tick. Each tick that has news appends one `autobio/memory` event carrying the minted recollection with the seq range it covered, the strategy's counters, and the settled call's provider-reported usage, which the session's tokenUsage projection folds into the cost estimate — memory formation is real spend and the estimate owns it. The text a call streams while it forms is appended beside the tick record as `autobio/memory-progress` records carrying the same attempt, so the chat renders one row per call: pinned open on that streaming text while the call runs, disclosing the minted recollection once it lands. The tick record itself stays the archive a later replay rebuilds the pyramid from. Ticks trickle in the background while the surface fits its budget, but when the picker finds no fitting layout the turn waits: catch-up ticks run on the inference thread until a layout fits, and a tick that forms nothing new (nothing left to compress) ends the wait. Even then the fully-folded floor can exceed the budget while the pyramid is mid-formation — shallow layers awaiting merge packs — so the pass retries once at the measured floor and lands the best layout there rather than stranding the session raw; only when even that yields no layout does the pass warn and leave the surface unchanged, and the next step retries.

#### KV Cache effect

The memory-formation request is not the conversation request: it assembles its own message list, and the harness's system prompt and tool definitions never reach it. It therefore neither reads nor invalidates the conversation's warm prefix, even though it runs on the same model the session is routed to.

## Known Limitations and Deferred Work

- **`compactRegion` is unimplemented** — the backend rejects an explicit region request with `ManualCompactionError('summary')` rather than folding a caller-chosen span. Regions fold as they age; `compactNow()` is the manual path that works.
- **A recollection whose ground has already been folded away is not re-announced** — a mint records the surface seqs it replaced at mint time. If those seqs no longer resolve in the replayed store when the tick reports, the mint is skipped for that pass and re-examined later, so a coverage range recorded while the surface was mid-fold can be lost across a restart. The fold node still stands and still replaces its span; only the pyramid entry's coverage citation goes missing.
- **Refinement of a folded span is clamped** — one `assistant/message` replace cannot split a span back into several nodes, so when the planned resolution is finer than what the surface already shows, the coarser recollection stays. The replay keeps every level and the raw records are never deleted, but the live view is monotone per region: a folded span does not return to raw.
- **Fold nodes are not seam checkpoints** — a recollection is an `assistant/message` carrying its `compactionId` instead of the `user/message` built from `compactCheckpointSource`. Consumers that recognize a compaction checkpoint by its message source do not recognize a recollection, and the model reads it as its own past rather than as an established-background checkpoint.
- **One node per fold** — a fold op shadows a span with exactly one node, and planning never grows a region's node count. Several nodes where one fold stands would be needed to refine a region without unfolding it.
- **Attachments are replayed as placeholders** — blocks the store cannot represent (images, documents, audio) become a `[<type> omitted from memory mirror]` text placeholder, so a recollection preserves the fact of an attachment but never its payload.
- **Summarizer request fields beyond the bridge's contract are dropped** — the bridge forwards `messages`, `system`, the generation cap, temperature, and the tool declarations a summarization request carries; other fields the library may add are not passed to `ctx.llm.stream()`.
- **Folding can lag a fast-growing session** — memory formation is one compression call per step, serialized per session, so a session whose foldable middle outgrows its budget faster than that cannot fit any layout: the pass warns with the token breakdown and leaves the surface unchanged instead of folding part of the way. The budget, the verbatim tail, and the summarizer's speed decide how much headroom a deployment has.
- **A surface coarser than the layout stands** — when the picker's planned resolution for a region is finer than a fold already landed there (budget growth, a deepened pyramid), planning keeps the coarser node and drops the finer entries: a coarser fold only shrinks the context below plan, and one replace cannot subdivide an existing node. A fold whose range merely starts inside a coarser node folds around it — the node keeps the head, the new fold shadows from the next surface node on. Divergences that are not strictly coarser still skip the whole pass (with a warning), and the next step retries. Folding therefore lands in bursts rather than every step, and a session that is already over budget stays over budget until an aligned pass lands.
- **A fold never splits a tool call from its result** — planning widens each fold's span until every shadowed call has its result shadowed too (chained in both directions across the surface), and refuses the pass — warning included — when the missing half is visible across an already-folded node, since a fold there would orphan the visible half and every later request would 400.
