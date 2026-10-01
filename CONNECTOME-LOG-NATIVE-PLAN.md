# Log-native Connectome: rebuild plan

Status: design agreed in discussion, pre-implementation. This doc captures the
decisions, the evidence behind them, and the pre-build verification list.

## Problem

`compaction-autobiographical` keeps two stores of the same history: the
session log (durable, authoritative) and a per-session Chronicle archive at
`.dsh/autobio/{sessionId}` (fragile, derived). Every systemic failure comes
from that split:

- Chronicle only becomes reopenable on clean close. Any unclean exit discards
  all un-checkpointed memory state, and the next open regenerates every
  recollection with real LLM calls.
- Measured on session `92eebb6b` ("The one red lemma, precisely", verus-cad):
  407 compression calls produced 201 distinct memories; 67 memory ids were
  minted 2–7 times each; ~30.2M input + 4.3M output tokens spent on memory
  formation over 8 days, ~60% of it regeneration. On 2026-09-30 after a 15:37
  restart: 60 mints, 48 of them re-mints; one hour showed 48 memory calls
  against 2 real agent steps — the fold pass's catch-up loop stalls the turn
  on the inference thread while the pyramid rebuilds.
- Fork inheritance copies the whole archive per fork (observed: five ~39MB
  copies of one lineage in this repo's own `.dsh/autobio`).
- The reconciliation layer between the two stores (watermark recovery,
  `promptOverhead` calibration, applicator repair) is where the bug tail
  lives (`fixup rare issue in compact`, `Fixup failure to compact sometimes`,
  ...).

The session log already contains everything the archive holds: the full
history (surface events), the fold structure (replace nodes with
`sourceEventSeqs`), and every recollection in full (`autobio/memory` events
carry id, level, tokens, and complete content). The second store adds zero
information.

## Decision

Keep the connectome library (`@animalabs/context-manager`) vanilla and
unpatched; replace only its storage backend. The store becomes an in-memory
scratch object with no durability role, re-seeded from the session log on
every open. The entire existing DSH integration package is thrown out and
rebuilt small.

One sentence: **the log is replayed into a scratch store on open, and folds
are the only writes.**

Key enabler, verified: `ContextManager.open` accepts `{ store: JsStore }`
(app-owned store) as an alternative to `{ path }`
(`ref/context-manager/src/context-manager.ts:222-244`), and nothing in the
library does `instanceof JsStore` — the store is duck-typed in practice.

## Components and line budget

~660 lines new (feature parity) against ~2,000 deleted (engine, mirror,
applicator, `command-autobio`, UI memory rows, Chronicle + membrane
native deps).

| Component | Lines | Notes |
|---|---|---|
| Store shim | ~120 | Map/array-backed implementation of the ~20 JsStore methods the library actually calls (verified by grep): state-slot get/set/append/edit/redact, `currentBranch` (constant), `currentSequence`, `getStateItemJson`/`getStateLen`/`getStateSlice`, `compactState`/`sync`/`close`/`isClosed` (no-ops or trivial). Blobs, tree state, subscriptions: loud throws — unreachable in our config, and a thrown method is the upgrade alarm. |
| Seed + live replay | ~130 | On open: replay surface events into the `messages` slot (reusing the existing block-mapping direction), replay `autobio/memory` events into the `summaries` slot, set the id counter to max. Then append new events live. No watermark: open = full replay. |
| Engine | ~220 | Per-session runtime, `agent/pre-step` fold pass: sync → background tick → compile → plan → apply. Config: 3 harness knobs (operating window, reserve, `auto`) plus a pass-through strategy bag. Never blocks a turn (see Behavior changes). |
| Frontier planner + widening | ~90 | Reads `strategy.resolutions` after `compile()`; groups per-message levels into runs; maps each run to its summary; widens spans to pair-safe boundaries (bounded, chain-free); emits one replace op per run. Divergence throws. |
| Fold apply | ~60 | Preflight assert + bracket events + one single-node replace per fold. Cannot make a pairing mistake — planning owns that. |
| Bridge | ~110 | Library `complete()` ↔ `ctx.llm.stream()`. Forwards `request.tools` (fixes the crippled refusal ladder, below). Uses the library's exported `splitMixedToolMessages` instead of the hand-rolled split. Keeps thinking-strip pricing (a fold must never cost more than the span it replaces) and usage on the done flush. |
| Types/config | ~50 | Schemastery schema for the harness knobs + loose strategy passthrough. |

Aggressive cuts available (−100 to −150 more): drop live memory-progress
streaming rows (keep settled `autobio/memory` events), drop `/autobio`.

## Design decisions, with evidence

### 1. Scratch store, seeded — not persisted

The earlier alternative (event-source every store mutation into the log as
`autobio/store` op events) was graded and rejected: it writes transient
bookkeeping (merge-queue churn, calibration writes, resolution updates) into
the durable log forever. The only state worth durability is what the log
already has: messages, summaries, folds. Everything else in the store is
recomputable bookkeeping — merge queues re-enqueue from threshold checks,
quarantines cost one retry per open at worst, resolutions are replanned by
the picker each compile.

Seeding works because the strategy's load path is plain `getStateJson` reads
(`autobiographical.ts:1960-2010`): pre-seed the shim before
`ContextManager.open({ store })` and the strategy "recovers" as if Chronicle
had persisted it. Chunk records re-derive from L1 summaries' `sourceIds` via
the library's own lazy-migration path (`autobiographical.ts` ~1735: "a store
with L1 summaries but an empty chunks slot predates chunk persistence").

Message-id determinism is free: `appendToStateJsonWithIdentity` means the
store assigns ids; the shim assigns ordinals; replay is in-order, so ids
reproduce exactly on every rebuild. Summaries' `sourceRange` (message ids)
therefore survives re-seeding.

Required log change: stamp `sourceRange` (first/last seq) on `autobio/memory`
events so seeds are exact. One line at the mint site.

### 2. Planning reads the frontier, not the rendered preview

The solver's output is first-class: `FoldingSolution.frontier:
Map<ChunkId, number>` (`adaptive/folding-strategy.ts:61`), applied into
`strategy.resolutions` (per-message level map). Connectome-host's own UI
reads that field directly (`ref/connectome-host/src/web/panel-data.ts:879`),
so this is the de-facto seam, not a new invention.

The current applicator instead screen-scrapes `previewContext` output —
parsing recall Q/A pairs, recovering summary ids off `cacheLayoutKey`,
reconstructing ranges. All of that deletes. With the frontier:

1. `compile(budget)`
2. read `strategy.resolutions`
3. group consecutive level-k messages into runs; a run maps to the L_k
   summary whose `sourceRange` covers it (`getSummary` /
   `getSummariesInRange` are public)
4. one replace op per run

Also deleted: the `UNBOUNDED_PREVIEW_TOKENS` self-pricing hack — the shim can
sum its own messages slot.

Drift note: `resolutions` is a protected field. The conformance test asserts
"level-k run == some L_k summary's sourceRange" so a silent upstream change
fails loud. A tiny public getter is the right upstream ask; not blocking.

### 3. Tool-pair safety: invariant-preserving bounded widening

The key fact, verified against the agent loop: **calls and results never
share a surface node** in DSH (`tool/result` events are pure user-role result
messages — `agent-loop/src/tool-calls.ts:281`; calls live in
assistant/messages). So widening a fold span to cover a straddled pair is
provably chain-free — one node backward, one bounded run forward — and if
every fold lands pair-safe, then inductively *the surface is always
pair-safe*: fold nodes never participate in straddles, and the old
applicator's chaining, absorbed-node bookkeeping, and refusal paths cannot
arise.

Widening happens in the planner against *final* post-pass visibility (a
neighbor half shadowed by a sibling op in the same pass needs nothing). Apply
is then pure mechanics that cannot make a pairing mistake. The current
applicator's complexity came from chaining against message shapes the harness
never produces.

Both simpler alternatives were considered and rejected: span-repair with
refusals (the status quo — bursty folding, skipped passes) and boundary stub
blocks (the library's render-side answer — creates stub-obligation
composition across later folds and a two-node fold convention).

### 4. Budget calibration: feed the library's closed loop

Delete `promptOverhead`. The strategy has public
`reportRealInputTokens(realTotal)` (`autobiographical.ts:8345`): a persisted
EMA multiplier on its own estimator, armed once per compile, with an
out-of-band sanity band. Its docstring documents the exact footgun our
per-pass hack dances around (multi-call turns inflating the multiplier).
Once per pass, feed the newest assistant-usage input total (already on the
session events we scan today). Steady-state system-prompt/tool/reasoning
overhead is absorbed into the multiplier; estimator error itself improves
over time instead of being corrected around.

### 5. Config is a passthrough bag

Connectome-host passes ~40 strategy knobs straight from recipe to strategy
(`framework-strategy.ts` `PASSTHROUGH_KEYS`). We re-enumerate 12 with our own
validation — every upstream knob currently needs a manual port. The rebuild
keeps only harness-side knobs in the schema and passes one `strategy` object
through untouched, so upstream improvements arrive with the version bump.
Trade-off: the config-catalog generator statically walks the schema; the
generated page for this plugin degrades to the harness knobs plus a bag note.

### 6. The bridge forwards tools

Current known limitation: "tool declarations the library may add to a
summarization request are not passed to `ctx.llm.stream()`." The library's
refusal ladder (appended retry line → drop-tools last rung,
`autobiographical.ts:115`/`:158`) only works if tools were on the request to
begin with; dropping them always pre-cripples rung one and pushes tool-chunk
refusals straight to quarantine. Forward `request.tools` (the schema mapping
already exists for `syncToolDefinitions`).

### 7. Folding never blocks a turn

Background ticks only. If no layout fits, the surface stays unchanged and the
provider's overflow recovery remains the terminal path. The catch-up loop on
the inference thread — the mechanism that stalled the red-lemma session for
hours — is not rebuilt.

### What stays ours, deliberately

Checked and confirmed to have no library equivalent: the shim (no in-memory
store exists upstream; even the library's tests use real
`JsStore.openOrCreate`), seed/replay, the ~40-line block mapping
(vocabularies are 1:1 renamed), and `autoTickOnNewMessage: false` (on, it
would fire a tick per replayed message during seeding). The membrane bridge
stays because routing compression calls through `ctx.llm` keeps credentials,
retry, and usage accounting with the harness adapters.

## What gets deleted

- Mirror write path, watermark recovery, `dshSeq` stamping
- `inheritForkArchive` (fork copies the log; store state inherits for free)
- Checkpoint-on-close lifecycle, `closeRuntimes`' durability role, LOCK files
- `.dsh/autobio` stores, Chronicle + membrane native dependencies
- `promptOverhead` + `UNBOUNDED_PREVIEW_TOKENS`
- `previewContext` entry parsing, recall-header reconstruction
- Applicator repair/chaining/refusal subsystem
- The catch-up wait loop

## Behavior changes vs. today

1. Folding never blocks a turn (above).
2. No on-disk state. Restart = re-seed from the log in milliseconds, zero LLM
   calls. Crash = nothing lost. The regeneration loop is structurally
   impossible.
3. Resolutions are not seeded; on reopen the picker replans from the pyramid
   and the applicator's coarser-than-plan rules absorb divergence.
4. Old sessions: seeded from their existing `autobio/memory` events; landed
   folds recover ranges from fold nodes; unlanded mints from the Chronicle
   era are dropped. Old `.dsh/autobio` dirs become deletable garbage.
5. The live surface is pair-safe by invariant; folds widen to the nearest
   pair-safe boundary instead of refusing or straddling.

## Alternatives considered

- **Event-sourced log-backed store** (every store mutation becomes a log
  event): rejected — pollutes the durable log with transient bookkeeping
  (mergeQueue churn, calibration writes) forever; more new concepts, more
  failure modes, more lines than the scratch store it beats.
- **Drop the library, hand-roll log-native folding** (per the
  [recallable-compaction proposal](.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md)
  direction): rejected for this change — the pyramid, picker, kv-stable
  solver, merge scheduling, and refusal machinery are real, maintained
  value (observed in the wild: 636 summaries up to L3 in one session), and
  keeping the library vanilla is what lets upstream improvements flow in.
  The recallable proposal remains live and orthogonal (recall tools, index
  stubs); this rebuild does not preclude it.
- **Status quo + targeted patches** (re-seed-from-log, periodic checkpoints,
  non-blocking catch-up): rejected — each patch treats a symptom of the
  two-store split; measured cost of the split is ~60% wasted memory-formation
  spend on one session alone.
- **Parse `previewContext` entries for planning**: rejected — reverse-
  engineers structured state the strategy already holds (`resolutions`);
  fragile against library render changes.
- **Boundary stub blocks** (the library's render-side answer to orphans):
  rejected — stubs create obligations that compose across later folds (a
  shadowed stub result orphans the stub call on an earlier fold node), need a
  two-node fold convention for one direction, and change fold-node
  recognition. Widening with the pair-safety invariant has none of that.
- **The current applicator's chained widening**: rejected — its chains guard
  against message shapes (calls and results in one node) the harness never
  produces, and its refusal paths turn plan/surface divergence into silently
  skipped passes. Bounded widening keeps the correct core.
- **Silent plan-skip on divergence** (the old `return null` paths): rejected
  — seeding is deterministic, so divergence is always a bug; throw, catch at
  the engine boundary, warn, continue the turn.

## Pre-build verification list

1. `strategy.resolutions` shape after `compile()` on a real replayed session
   (per-message id → level; runs align with summary sourceRanges).
2. `reportRealInputTokens` call contract: exactly which token total it
   expects (fresh + cache_read + cache_creation, minus known non-window
   overhead) and when the arm fires relative to `compile()`.
3. Conformance smoke test: drive the shim through a replay of the 1.27M-event
   red-lemma session log; assert identical seeds across two opens and a
   plan that matches the session's actual fold history.
4. `setStateJson` write volume per tick (confirms no hot-path whole-array
   writes; whole-array writes observed only on load-repair paths).
5. Whether two processes can hold the same session live (Chronicle's LOCK
   used to answer this for the archive; the answer must come from session
   ownership now).

## Acceptance criteria

- Kill -9 mid-session, reopen: zero compression calls spent on regeneration;
  the picker plans from the seeded pyramid immediately.
- Fork a session: no archive copy; child seeds from its inherited log events.
- The red-lemma session replays through the shim with the same fold history
  it actually lived.
- A fold never splits a tool pair on the wire: the pair-safety invariant is
  covered by scripted straddle tests at both boundaries (including sibling-op
  adjacency) and by a property test replaying real session logs through the
  real serializer.
- A turn is never delayed by memory formation.
- `pnpm dsh` runs with no Chronicle native dependency.
- Net diff: ~−1,300 lines.

## Risks

- **Protected-field dependency** (`strategy.resolutions`): same seam
  connectome-host uses; guarded by the conformance test; a public getter is
  the upstream ask.
- **Duck-typed `JsStore`**: not an officially supported injection surface;
  guarded by loud throws on unimplemented methods plus the conformance test.
- **Seed fidelity for exotic states**: quarantines and in-flight merges reset
  per open (self-healing, bounded); a mid-merge crash costs at most one
  re-merge.
- **Calibration is multiplicative**, overhead is partly additive; the EMA
  settles near-truth and the sanity band rejects wild samples, but a session
  with wildly varying overhead may sit slightly miscalibrated. Acceptable:
  the failure direction is a slightly early fold, not an overflow.
