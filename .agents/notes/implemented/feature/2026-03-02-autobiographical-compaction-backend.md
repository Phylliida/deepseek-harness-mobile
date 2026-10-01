# Agent Note: Autobiographical compaction backend

Status: implemented

English | [中文](2026-03-02-autobiographical-compaction-backend.zh.md)

## Problem

A long session eventually meets a fixed context window. The harness's answer is [pressure compaction](../../implemented/feature/2026-06-18-compaction-capability-seam.md): when the surface crosses the threshold, one range is replaced by a checkpoint, and each later checkpoint merges the previous one. A session can therefore run indefinitely, but its oldest history survives as a block the agent did not write, from no particular vantage point, with no account of what rewriting it costs under the provider's prompt cache.

The Anima Connectome `@animalabs/context-manager` `AutobiographicalStrategy` exists for that gap. It chunks aged history, folds each chunk into a first-person recollection at a planned resolution, merges recollections into coarser levels as they accumulate, and re-plans the layout every turn against a token wall whose objective is prompt-cache perturbation rather than token count alone.

Adopting it forces four questions this note settles: where authority over the conversation lives when a second store plans over it, whether the memory engine is a dependency or vendored source, how a recollection rides a seam whose summary convention is a user-role checkpoint, and how a human stops the engine from forming memories without unloading the backend.

## Decision

`packages/compaction/compaction-autobiographical` is a second Service Provider for `ctx.compaction`, driven by the `AutobiographicalStrategy`. Configuration, the model-visible contract, and the known limitations live in the [package README](../../../../packages/compaction/compaction-autobiographical/README.md).

## Where authority lives: the strategy plans, the harness disposes

The harness session log stays the only authority. A per-session `ContextManager` runs over an in-memory store standing in for the library's `JsStore`, and folds are its only writes. Nothing else feeds it: the store lives as long as the runtime slice, so there is no second durable artifact per session and no watermark to recover from.

Opening a session therefore rebuilds rather than resumes. Append-origin surface events replay once, each stamped with its log seq, and a recollection is rebuilt from the two places the log already holds it — an `autobio/memory` event carries its body, level, and covered seq range, and the `assistant/message` that replaced its span carries the same text under a `compactionId` (`autobio:<summaryId>`) naming the recollection it stands for. Replacement nodes are never mirrored, because the planner finds a fold node's ground already covered and asks for no fold there.

The strategy's only output is a layout. The backend diffs that layout against the live surface and lands the difference through the seam's bracketed transaction (`compaction/start`, one `compaction/summary` per fold, `compaction/end`), so a fold is a logged, metered, replayable surface mutation rather than a private edit inside another store.

## Reuse the published packages instead of vendoring source

`@animalabs/context-manager` and `@animalabs/membrane` are npm dependencies. A `MembraneBridge` adapts the library's `complete()` onto `ctx.llm.stream()`, so credentials, routing, retry, and usage stay in the harness adapters and only request assembly is ours. Membrane is on the graph either way, because the library value-imports the native formatter.

Vendoring, the [Cordis approach](../../../../vendor/README.md), was rejected. The library is 26k lines of source over a Rust N-API store; vendored outside the coverage gate's `packages/*/*/src` include scope it would become a large code home nothing measures, and vendored inside a package it would drag external source under per-file 100% coverage plus a standing review burden of foreign code. A dependency keeps the update path to a version bump and confines harness-owned code to the store shim, the planner, and the bridge.

## Fold nodes are assistant recollections, not seam checkpoints

The seam's convention for a replacement is a `user/message` built by `compactCheckpointSource` and framed to the model as established background. A recollection is neither background nor the user's: it is the agent's own past. It therefore lands as an `assistant/message` whose `compactionId` is the library's fold id and the seam transaction's id at once, so a later pass recognizes a fold node from the source and parses no prose back out.

Its text still opens with a `[Recall <id>]` header, which is the convention folds written before `compactionId` carried and the fallback the replay reads for them. The source id is authoritative where both exist; the header is strictly a fallback.

The cost is stated rather than hidden: a consumer that identifies a compaction checkpoint by message source will not recognize a fold node, so any future seam-level checkpoint bookkeeping must either learn this second shape or treat fold nodes as ordinary assistant messages.

## Planning from what the strategy reports, not from a second resolver

The backend calls `manager.compile(budget)` to resolve the layout, then plans from the entries the strategy says it holds. Planning partitions the surface by recollection and annotates each node with the original seqs it covers, expanding a fold node down to the events it stands for so coverage stays comparable across fold levels. The span the strategy keeps verbatim is read from its own recent-window start; deriving either from anything else would duplicate the resolver inside this package.

The budget is the adapter-reported context window, overridable by config and capped by `operatingWindowTokens`. A frontier that cannot fit even at its coarsest resolution raises `OverBudgetError`, which the backend retries once at the measured floor and otherwise absorbs: the surface stays as it was and the provider's own overflow recovery remains the terminal authority. Folding is likewise not gated on the seam's pressure triggers — a span folds when the strategy's resolution for it says so, which is what makes the schedule continuous rather than reactive.

## Voice integrity constrains the memory-formation route

Memories are identity-bearing, so the strategy receives the session's own routed model as its `compressionModel` and refuses to form memories under a substitute voice. There is deliberately no configurable summarization route: autobiographical memory is the agent writing about its own history, so memory formation always follows the session's latest routed request, and a session with no resolvable route folds nothing rather than delegating to another model. Compression calls carry `purpose: 'compaction'`.

## Fold shape: one node per span, and refinement is clamped

A fold shadows a span with exactly one node, and planning never grows a region's node count. That shape is what makes every fold expressible as the seam's existing replace op, and it is sufficient for coarsening — the direction a growing session moves.

It is also the source of the backend's central limitation. A planned resolution finer than what the surface already shows cannot be applied, because one node cannot split back into several, so the coarser recollection stands. Every level survives in the log and no raw record is deleted, but the live view is monotone per region: a folded span does not return to raw. Un-folding needs a surface capability the seam does not have, so `compactRegion()` rejects with `ManualCompactionError('summary')` instead of pretending otherwise.

## Fold eligibility needs the session's tool schemas

The library refuses to compress a chunk containing tool blocks until the host has declared the agent's tool definitions, because a tools-less replay of a tool transcript trips provider refusal classifiers. The backend therefore pushes the schemas the live request carries into the context on every pass, mapped into the library's own type. Without that the backend would look healthy on prose-only sessions and never fold the tool-heavy sessions that most need it — the failure is a silent deferral, not an error.

The compression call still declares no tools on the wire: the compression path cannot continue a tool-call answer, and the library's own retry policy assumes the summarizer may answer on-pattern, so declaring them would invite a reply the path has to reject.

## Automatic folding is a load-time setting

`auto` (default `true`) decides at load whether the step-boundary listener is registered, and the constructor is the only thing that reads it. Explicit folding stays available regardless: `compactNow()` ignores the seam's trigger and folds on demand, and `/compact` reaches it.

There is no runtime switch and no state accessor. Turning folding off is a config change plus a reload, and a session left with `auto: false` folds only when something calls `compactNow()`.

## Alternatives considered

- **Run the `ContextManager` as a sidecar that owns the conversation.** Rejected: the harness would keep its own log and surface while a second store decided what the model sees, so shadowing, projection, repair, tool pairing, and transcript derivation would each need a parallel implementation, and two authorities would have to agree on ordering and recovery indefinitely.
- **Keep a durable store beside the log.** Rejected: it is a second artifact per session, outside whatever retention the log has, and losing it discards formed memories while the log stays intact — while keeping it needs a watermark, a mirror, and reconciliation between the two that a replay simply does not have.
- **Vendor the Anima sources.** Rejected for the coverage-gate and review reasons above; a forked memory engine would additionally need hand-syncing against library changes.
- **Drive the strategy without replaying the log.** Rejected: the library compresses continuously and in the background, so a replay-free design would re-feed history on demand and lose both the tick schedule and the as-of vantage that makes a recollection testimony from a moment rather than hindsight.
- **Reuse `compaction-basic`'s protected `summarize()` hook.** Rejected: that hook produces one summary for one range on demand, so it cannot express a hierarchy, a per-span resolution, or a cache-aware schedule — the parts worth adopting.
- **Emit the seam's `user/message` checkpoint.** Rejected: it would present the agent's own recollection as user text or as established background, contradicting the voice the design depends on. The recognition cost is recorded above instead.
- **Fold a span into several nodes.** Deferred to a surface capability that does not exist yet: it would let a region refine without unfolding, which is where the clamped-refinement limitation should eventually be fixed.
- **Gate folding on the seam's `pressure`/`context-overflow` triggers.** Rejected: the library's own design record names count-or-crisis gating as the failure mode it was built to replace, because it defers deep re-folds into rare, maximally expensive moments.

## Consequences

The trade-off bought a design with one durable copy of anything. A session that outgrows its window keeps serving requests with the verbatim recent tail unfolded, aged spans replaced by `[Recall <id>]` assistant recollections, and every original event still present in the log; reopening replays that log rather than reconciling a second store, and a previous run's folds are not re-formed, because the planner finds the ground they cover already taken. Every fold appears as `compaction/start` … `compaction/summary` … `compaction/end` under one `compactionId`, with `CompactionResult` reporting the shadowed seqs and token estimate that actually landed. Planning failures, unknown context windows, and over-budget frontiers leave the surface byte-identical for that pass, and `compactRegion()` rejects with `ManualCompactionError('summary')`.

It cost the runtime toggle. Stopping memory formation at runtime and turning it back on without unloading the backend was a real capability, and it is gone: the human surface for it, its two accessors, and the command package that carried both are deleted rather than maintained, because the whole of that surface answered one load-time boolean. A session already running keeps folding until it is reconfigured and reloaded, and the log records no reason for folds stopping.

It also cost a replay on every open. A long session re-reads its own history to rebuild the pyramid, which is work the durable store did once at a watermark; the log is a read the session already has open, so the price is paid in time rather than in correctness.

- Clamped refinement is a visible fidelity ceiling: a region can only coarsen while folded, so a session whose budget shrinks and later grows does not recover the detail it shed. Until the surface can express a multi-node fold, `recentWindowTokens` is the only lever keeping a region raw.
- Fold nodes are assistant messages, so a client, gate, or migration assuming compaction always leaves a user checkpoint will mis-handle them.
- The library is a fast-moving external dependency whose prompts and defaults are model-visible, so a version bump can change what the model reads with no change in this repository.
- Memory formation is a real inference per chunk. A large backlog pays that cost in the background, so a misconfigured route or concurrency setting surfaces as slow folding rather than as a turn failure.
- The `kv-stable` policy was calibrated against Anthropic prompt-cache economics. The strategy is cache-aware in structure, but its constants were not tuned for this harness's providers.
- A session can keep growing while folding is switched off, which is the state the backend exists to prevent: the surface stops coarsening and the next pass pays a larger fold.
- Tool schemas are pushed per pass and only the latest set is retained, so a fold of a transcript recorded under a different tool set is compressed against the current one — the library's own single-slot contract, not a harness omission.
