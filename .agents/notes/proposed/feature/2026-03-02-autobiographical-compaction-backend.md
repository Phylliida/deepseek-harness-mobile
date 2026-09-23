# Agent Note: Autobiographical compaction backend

Status: proposed

English | [中文](2026-03-02-autobiographical-compaction-backend.zh.md)

## Problem

A long session eventually meets a fixed context window. The harness's answer is [pressure compaction](../../implemented/feature/2026-06-18-compaction-capability-seam.md): when the surface crosses the threshold, one range is replaced by a checkpoint, and each later checkpoint merges the previous one. A session can therefore run indefinitely, but its oldest history survives as a block the agent did not write, from no particular vantage point, with no account of what rewriting it costs under the provider's prompt cache.

The Anima Connectome `@animalabs/context-manager` `AutobiographicalStrategy` exists for that gap. It chunks aged history, folds each chunk into a first-person recollection at a planned resolution, merges recollections into coarser levels as they accumulate, and re-plans the layout every turn against a token wall whose objective is prompt-cache perturbation rather than token count alone.

Adopting it forces four questions this note settles: where authority over the conversation lives when a second store plans over it, whether the memory engine is a dependency or vendored source, how a recollection rides a seam whose summary convention is a user-role checkpoint, and how a human stops the engine from forming memories without unloading the backend.

## Proposal

Add `packages/compaction/compaction-autobiographical` as a second Service Provider for `ctx.compaction`, driven by the `AutobiographicalStrategy`, plus `packages/compaction/command-autobio` as the human control over its automatic folding. Configuration, the model-visible contract, and the known limitations live in the [package README](../../../../packages/compaction/compaction-autobiographical/README.md); the command's own contract lives in [its README](../../../../packages/compaction/command-autobio/README.md).

## Where authority lives: the strategy plans, the harness disposes

The harness session log stays the only authority. A per-session `ContextManager` over a Chronicle store mirrors the conversation so the strategy can plan over it, and the mirror is one-way from the harness's side: append-origin surface events replay once, each stamped with its log seq, and replacement nodes — this backend's own folds included — are never mirrored back. The replay watermark recovers from the newest mirrored message, so reopening a session continues rather than re-ingesting.

The strategy's only output is a layout. The backend diffs that layout against the live surface and lands the difference through the seam's bracketed transaction (`compaction/start`, one `compaction/summary` per fold, `compaction/end`), so a fold is a logged, metered, replayable surface mutation rather than a private edit inside another store.

## Reuse the published packages instead of vendoring source

`@animalabs/context-manager` and `@animalabs/membrane` stay npm dependencies, and Chronicle arrives transitively through the former. A `MembraneBridge` adapts the library's `complete()` onto `ctx.llm.stream()`, so credentials, routing, retry, and usage stay in the harness adapters and only request assembly is ours.

Vendoring, the [Cordis approach](../../../../vendor/README.md), was rejected. The library is 26k lines of source over a Rust N-API store; vendored outside the coverage gate's `packages/*/*/src` include scope it would become a large code home nothing measures, and vendored inside a package it would drag external source under per-file 100% coverage plus a standing review burden of foreign code. A dependency keeps the update path to a version bump and confines harness-owned code to the mirror, applicator, and bridge.

## Fold nodes are assistant recollections, not seam checkpoints

The seam's convention for a replacement is a `user/message` built by `compactCheckpointSource` and framed to the model as established background. A recollection is neither background nor the user's: it is the agent's own past. It therefore lands as an `assistant/message` whose text opens with a `[Recall <id>]` header, which is also how later passes recognize a fold node and expand its footprint.

The cost is stated rather than hidden: a consumer that identifies a compaction checkpoint by message source will not recognize a fold node, so any future seam-level checkpoint bookkeeping must either learn this second shape or treat fold nodes as ordinary assistant messages.

## Planning from rendered entries, not from the strategy's internals

The backend calls `manager.compile(budget)` to resolve the layout, then `previewContext(budget, undefined, { render: true })` to obtain the entries that layout would actually render. Planning reconciles those rendered entries against the surface, annotating each node with the original seqs it covers so coverage stays comparable across fold levels. Deriving the plan from anything else would duplicate the resolver inside this package.

The budget is the adapter-reported context window, overridable by config. A frontier that cannot fit even at its coarsest resolution raises `OverBudgetError`, which the backend logs and absorbs: the surface stays as it was and the provider's own overflow recovery remains the terminal authority. Folding is likewise not gated on the seam's pressure triggers — a span folds when the strategy's resolution for it says so, which is what makes the schedule continuous rather than reactive.

## Voice integrity constrains the memory-formation route

Memories are identity-bearing, so the strategy receives the session's own routed model as its `compressionModel` and refuses to form memories under a substitute voice. There is deliberately no configurable summarization route: autobiographical memory is the agent writing about its own history, so memory formation always follows the session's latest routed request (falling back to the agent's own target), and a session with no resolvable route folds nothing rather than delegating to another model. Compression calls carry `purpose: 'compaction'`.

## Fold shape: one node per span, and refinement is clamped

A fold shadows a span with exactly one node, and planning never grows a region's node count. That shape is what makes every fold expressible as the seam's existing replace op, and it is sufficient for coarsening — the direction a growing session moves.

It is also the source of the backend's central limitation. A planned resolution finer than what the surface already shows cannot be applied, because one node cannot split back into several, so the coarser recollection stands. The archive retains every level and the raw log records are never deleted, but the live view is monotone per region: a folded span does not return to raw. Un-folding needs a surface capability the seam does not have, so `compactRegion` is unimplemented and rejects instead of pretending otherwise.

## Fold eligibility needs the session's tool schemas

The library refuses to compress a chunk containing tool blocks until the host has declared the agent's tool definitions, because a tools-less replay of a tool transcript trips provider refusal classifiers. The backend therefore pushes the session's assembled schemas into the archive on every pass. Without that the backend would look healthy on prose-only sessions and never fold the tool-heavy sessions that most need it — the failure is a silent deferral, not an error.

The declarations are the schemas the live request carries, mapped into the library's own type. The compression call still declares no tools on the wire: the compression path cannot continue a tool-call answer, and the library's own retry policy assumes the summarizer may answer on-pattern, so declaring them would invite a reply the path has to reject.

## The runtime toggle gates automatic folding, not the engine

`setAutomaticFolding(false)` removes the step-boundary listener the `auto` config knob registers; `isAutomaticFoldingEnabled` reports the state, and `/autobio` in `packages/compaction/command-autobio` is the human surface for it. Removing the listener rather than gating inside it keeps one meaning for the disabled state: a backend constructed with `auto: false` and a backend switched off at runtime are the same backend, with no step-boundary presence at all.

Only the engine's own schedule is gated. Explicit folding stays available — `/compact`, and any other caller of `compactNow()`, still folds — because the toggle answers "should the agent rewrite its history on its own", not "may this session ever fold again". A pass already in flight when the toggle lands still finishes, including a memory-formation call already running.

The command is backend-specific and says so: it narrows `ctx.compaction` to `AutobiographicalCompactionEngine` and reports an error for any other provider, because compaction is a seam with several providers and a control surface that silently no-ops on the one it does not drive is worse than one that refuses. Two consequences are stated rather than hidden: the state is runtime-only (a restart returns to the configured `auto`, and the log records no reason for folds stopping), and it covers the whole context, since one engine serves every session in it.

## Alternatives considered

- **Run the `ContextManager` as a sidecar that owns the conversation.** Rejected: the harness would keep its own log and surface while a second store decided what the model sees, so shadowing, projection, repair, tool pairing, and transcript derivation would each need a parallel implementation, and two authorities would have to agree on ordering and recovery indefinitely.
- **Vendor the Anima sources.** Rejected for the coverage-gate and review reasons above; a forked memory engine would additionally need hand-syncing against library changes.
- **Drive the strategy without mirroring the log.** Rejected: the library compresses continuously and in the background, so a mirror-free design would re-feed history on demand and lose both the tick schedule and the as-of vantage that makes a recollection testimony from a moment rather than hindsight.
- **Reuse `compaction-basic`'s protected `summarize()` hook.** Rejected: that hook produces one summary for one range on demand, so it cannot express a hierarchy, a per-span resolution, or a cache-aware schedule — the parts worth adopting.
- **Emit the seam's `user/message` checkpoint.** Rejected: it would present the agent's own recollection as user text or as established background, contradicting the voice the design depends on. The recognition cost is recorded above instead.
- **Fold a span into several nodes.** Deferred to a surface capability that does not exist yet: it would let a region refine without unfolding, which is where the clamped-refinement limitation should eventually be fixed.
- **Gate folding on the seam's `pressure`/`context-overflow` triggers.** Rejected: the library's own design record names count-or-crisis gating as the failure mode it was built to replace, because it defers deep re-folds into rare, maximally expensive moments.

## Acceptance criteria

- A session that outgrows its window keeps serving requests with the verbatim recent tail unfolded, aged spans replaced by `[Recall <id>]` assistant recollections, and every original event still present in the log.
- Every fold appears as `compaction/start` … `compaction/summary` … `compaction/end` under one `compactionId`, with `CompactionResult` reporting the shadowed seqs and token estimate that actually landed.
- Recollection bodies are written by the session's own routed model; a session with no resolvable route folds nothing and warns.
- Reopening a session over an existing store continues from its watermark rather than re-mirroring history, and `agent/disposed` closes the store so the next opener is not locked.
- Planning failures, unknown context windows, and over-budget frontiers leave the surface byte-identical for that pass.
- `compactNow()` folds on demand, and `compactRegion()` rejects with `ManualCompactionError('summary')`.
- A session whose history contains tool blocks folds once its assembled tool schemas are in the archive.
- Automatic folding switches off and on at runtime without unloading the backend: no fold lands between steps while it is off, explicit calls still fold, and the command reports the state it left.
- The package's tests pin folding into an assistant recollection node, the verbatim tail surviving, region rejection, store-resume across engine restarts, the tool-schema push, and both toggle transitions.

## Risks

- Clamped refinement is a visible fidelity ceiling: a region can only coarsen while folded, so a session whose budget shrinks and later grows does not recover the detail it shed. Until the surface can express a multi-node fold, `recentWindowTokens` is the only lever keeping a region raw.
- Fold nodes are assistant messages, so a client, gate, or migration assuming compaction always leaves a user checkpoint will mis-handle them.
- The mirror is a second durable artifact per session under `storeRoot`, outside whatever retention or backup policy the session log has; losing it discards formed memories even though the log is intact.
- The library is a fast-moving external dependency whose prompts and defaults are model-visible, so a version bump can change what the model reads with no change in this repository.
- Memory formation is a real inference per chunk. A large backlog pays that cost in the background, so a misconfigured route or concurrency setting surfaces as slow folding rather than as a turn failure.
- The `kv-stable` policy was calibrated against Anthropic prompt-cache economics. The strategy is cache-aware in structure, but its constants were not tuned for this harness's providers.
- A session can keep growing while folding is switched off, which is the state the backend exists to prevent: the surface stops coarsening and the next pass pays a larger fold, so the toggle is a diagnostic and cost-control lever rather than a mode to leave on.
- Tool schemas are pushed per pass and only the latest set is retained, so a fold of a transcript recorded under a different tool set is compressed against the current one — the library's own single-slot contract, not a harness omission.
