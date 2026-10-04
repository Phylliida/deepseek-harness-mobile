# Log-native Connectome: fix plan

Status: audit complete, fixes not started. This doc is the spec for fixing every
finding from a three-pass audit of `packages/compaction/compaction-autobiographical`
against `CONNECTOME-LOG-NATIVE-PLAN.md` and `CONNECTOME-LOG-NATIVE-IMPLEMENTATION.md`.
It is written to be handed to a fresh context: the findings inventory is the
authoritative spec — the two design docs are partly stale (see Doc drift).

## Working-tree state

Baseline: commit `c04b7dc` plus uncommitted work that must be kept and built
upon, not reverted:

- `src/{index,seed,plan,types}.ts` — live `autobio/memory-progress` streaming,
  JSON-storability guard on the mint record, attempt-counter hardening, and the
  `Ranges` chain resolver for L≥2 ranges.
- `packages/client/ui-conversation/` — new `autobio-memory` chat node
  (`conversation-nodes/autobio.ts`, `chat/AutobioMemoryNodeView.tsx`,
  `chat/AutobioMemoryRow.module.css`) rendering one row per memory-formation
  call.
- `packages/core/session/src/known-event-types.ts` — `autobio/memory-progress`
  added to the vocabulary.
- `docs/persistence-catalog.*` — generated; never hand-edit. Change the
  annotated source (`src/types.ts`) and regenerate.

Design constraints (owner-stated, binding on every fix):

1. Every model request must produce a visible row in the GUI.
2. Minimize lines of code and duplicate stores; maintainability first.
3. Use the connectome library (`@animalabs/context-manager`) vanilla and
   directly wherever possible, so upstream improvements flow in.

Package test suite at baseline: 165/165 green
(`npx vitest run packages/compaction/compaction-autobiographical`). Green is not
evidence of correctness here: the fixtures are text-only, never reopen a minted
pyramid, and never mount the invariants service — every critical finding sits
in an untested path.

## Evidence legend

- **[ran]** — reproduced by executing the package's built artifacts or the real
  engine over a synthetic log.
- **[inference]** — read from library/harness source, not executed. Verify
  empirically as part of the fix.
- File:line references are against the baseline tree above and will drift as
  parts land; locate by symbol, not by line.

## Process

Five sequential parts. One fresh subagent implements each part; the parent
audits the diff before the next part starts. Order matters: Parts 1 and 2 both
edit `seed.ts`; Part 4's multi-op loop is unsafe until Part 3's widening and
preflight exist.

Subagent rules for every part:

- Read root `AGENTS.md`, the package `README.md`, and the findings below
  before editing. The findings are the spec; where a design doc contradicts
  them, the findings win and the doc gets fixed in Part 5.
- No git commits. Scope edits to the part; no drive-by refactors.
- Every fix ships with a test that exercises the fixed path (not just covers
  the line). The coverage gate is `perFile: true` at 100% on all four metrics;
  exports need JSDoc (`verify-export-jsdoc`).
- Comment style: terse rationale matching the existing files. Comments must
  assert only what the code does — several current bugs hide behind comments
  that assert guarantees the code lacks; do not add new ones.
- Run `npx vitest run packages/compaction/compaction-autobiographical` green
  before reporting. Report what changed, why, test evidence, and anything
  deferred.

Parent audit checklist per part: diff scoped to the part; suite green; new
tests fail without the fix; comments assert only implemented behavior; no
unrelated churn; findings for the part verifiably closed.

## Part 1 — Store/seed boundary correctness

Files: `src/store.ts`, `src/seed.ts`, `src/index.ts` (live-sync call site only),
tests.

- **S1 [critical, ran]** Seeding never maps blocks into the library's
  vocabulary. `seed.ts` (`writeMessage`) writes harness blocks verbatim
  (`tool-call`/`tool-result`/`reasoning`); the library prices those at 0 tokens
  (`MessageStore.computeBlockTokensRaw`, `default: return 0`), its tool-pair
  and chunk-content checks read the same blind vocabulary, and a driven
  30-turn tool transcript produced a summarization request with 38 messages
  reduced to `[… omitted from memory-formation transcript]`. Fix: restore the
  harness→membrane mapping the deleted `mirror.ts` had (recover
  `toMembraneBlock` from git history: `git log --all --oneline -- '**/mirror.ts'`,
  then `git show <rev>:<path>`) and apply it on both the seed and live-sync
  paths. Acceptance: a seeded tool/reasoning transcript prices above zero,
  `chunkHasToolBlocks` sees the tools, and a driven memory-formation request
  contains no `omitted` placeholders.
- **S5 [high, ran]** Live sync appends straight to the store
  (`appendSurfaceNode`), leaving `MessageStore.idToIndex` permanently stale:
  `manager.getMessage(liveId)` → null after a mirrored append (the index
  revalidates only against write versions that `MessageStore.append` bumps).
  Fix per the implementation doc's original design: route live appends through
  `manager.addMessage(...)` (the `dshSeq` stamp rides the options argument;
  `autoTickOnNewMessage: false` keeps `onNewMessage` to bookkeeping).
  Acceptance: `manager.getMessage` resolves a live-mirrored message; existing
  fold behavior unchanged.
- **S9 [low]** Shape conformance: `seed.ts` stores a `Date` where Chronicle
  stores `Date.now()` (library has `typeof t === 'number'` filters), and
  appended content is not JSON round-tripped, so the library receives the
  session's deep-frozen arrays. Store millis and round-trip (or document why
  not with a test pinning the choice).
- **S10 [low, decision]** `IMPL` pseudocode skips zero-block events
  (`if blocks.length == 0: continue`); the code lands a row for them. Pick one
  rule, keep message-id determinism (replay must reproduce ids exactly), pin it
  with a test.
- **T1–T5 store hardening [low]**:
  - T1: add `sync`/`close`/`isClosed` no-ops — `ContextManager.sync()` calls
    `store.sync()` and today hits the Proxy drift thrower.
  - T2: `PROBED` gaps — the Proxy answers `then`/`toJSON` with the thrower
    (`await store`, `JSON.stringify(store)` raise drift errors), and omits
    `queryStateIndexRange`/`queryStateIndexEq`, which the library
    `typeof`-probes, making its designed unsupported-index fallback
    unreachable.
  - T3: `record()` JSON-stringifies full payloads on every append; no library
    code reads `.payload`. Drop the serialization (constraint 2).
  - T4: `setStateJson` on an unregistered id followed by `registerState`
    leaves reads on the stale scalar while appends go to the new array.
  - T5: `editStateItem` past the array end writes sparsely instead of failing.

## Part 2 — Pyramid seeding fidelity

Files: `src/seed.ts`, tests. Runs after Part 1 (same file).

- **S2 [critical, ran]** `rebuildPyramidLinks` was never implemented: seeded
  summaries carry no `parentId`/`mergedInto`. Probe: after `ContextManager.open`
  alone on a seeded pyramid (12 L1s + 2 landed L2s), the merge queue
  repopulates over already-merged children — one model call per run per
  restart, plus duplicate L2+ mints in the log. This violates the headline
  acceptance criterion (reopen = zero compression calls). Check the installed
  library for which field gates merge eligibility (`getSummaryParentId` reads
  `parentId ?? mergedInto`) and stamp accordingly. Note `plan.ts`'s superseded
  filter reads the same pointer, so seeded merged children also keep
  "standing" for the planner until this lands.
  Acceptance: reopen a session with a merged pyramid, assert zero bridge calls
  and an empty merge queue.
- **S3 [high, ran]** A minted-but-unfolded L≥2 recollection is dropped: child
  resolution requires the child's fold-node seq inside `widened`, but with no
  fold node naming the parent, `widened` is a message-seq interval and a fold
  node's seq always exceeds everything it shadows — the last child is excluded
  by construction.
- **S4 [high, ran]** Seeded L≥2 `sourceRange` holds child summary ids
  (`{first: "L1-0", last: "L1-1"}`) where upstream stores leaf message ids:
  `recallCurveLeafIds` returns null, `listSummariesInRange` skips the entry,
  L3 merges over it fail validation. Resolve through the children to leaf ids.
- **S6 [medium]** The counter seeds from recollections that survive both
  gates, so it can land below the log's highest minted id → id reuse, and the
  first-wins dedupe then keeps the dropped record forever. Advance the counter
  over every logged recollection id, dropped or not.
- **S7 [medium]** `readMemoryLog` first-wins ignores whether a later record of
  the same id carries a range; a ranged mint can be shadowed by an earlier
  range-less one. Prefer the record with coverage.
- **S8 [medium, perf]** `legacyRange` runs an unconditional O(events) scan per
  recollection even when the mint carries `sourceRange` (~2.5×10⁸ iterations at
  red-lemma scale, against the docs' sub-second cold open). Guard on
  `memory.range === undefined` (only `at` needs the legacy path) and build the
  fold-node index once per log, not per recollection. Memoize `groundOf`
  (rebuilt per pass today).

## Part 3 — Pair-safe widening, preflight, pricing

Files: `src/plan.ts`, `src/apply.ts`, tests. Must land before Part 4's loop.

- **P1 [high, ran]** Backward widening is one node deep. For a normal parallel
  round `A(c1,c2) → R1 → R2`, a recollection starting at R2 sees R1 (which
  declares results, not calls) and does not reach — the landed fold leaves a
  visible `tool_calls` with no tool message, the exact wire-400 widening exists
  to prevent. Fix: walk the contiguous preceding result run that answers a
  call inside the span. Add a multi-call/R2 fixture; the current pair-safety
  acceptance tests are all single-call.
- **P2 [high, ran]** No final-visibility model: `widen` never sees sibling ops,
  and spans overlap in practice (repro: shadowed `[2,3]` ∩ `[2,3,4,5,6]`),
  falsifying the "spans are already disjoint" claim in the docs and comments.
  Fix: compute every op's claimed surface positions once; stop widening at
  sibling-owned nodes. The test named "stops widening where the next node
  belongs to a sibling fold" currently passes for a different reason — make it
  exercise the sibling boundary it names.
- **P3/P4 [medium, ran]** Consequences of overlap-based `covers`: a landed
  fold node gets subsumed by a sibling (the subsumed recollection leaves the
  wire with nothing standing for its ground), and a fold node straddling two
  windows gives both ops the identical span. Define fold-node ownership (a
  fold node belongs to the recollection it names) and assert subsumption only
  when the subsuming recollection actually stands over that ground.
- **P5 [high, ran]** No preflight: `assertFoldOpsApply` exists nowhere; a
  refused replace strands a durable `compaction/start` plus a metered phantom
  summary, and with the invariants service mounted the session wedges (every
  later `compaction/start` and turn boundary throws). `apply.spec.ts` pins the
  dangling bracket as expected — re-pin it to preflight refusal leaving no
  events. Fix: before any bracket opens, assert every span is present on the
  live surface and spans are pairwise disjoint; route payload/JSON refusal
  through the same preflight (`foldBlocks` replays membrane content verbatim).
- **P7 [medium, ran]** `shadowedTokens` prices only text blocks at chars/4:
  measured 3 vs the token meter's 1038 for the same nodes, so a shrinking fold
  can register as growth in the projection. Price with the meter's
  `estimateMessage`, as the tool-result pruner already does.
- **P8 [low-medium, ran]** Legacy fold nodes (`autobio-session-*` compaction
  ids) are recognized only by `seed.ts`, not by `foldIdOf` — each legacy fold
  is re-folded once and counts as foreign ground meanwhile. Fold the
  `[Recall <id>]` header into `foldIdOf`.
- **P9 [low]** Unchecked cast on the coverage map throws `TypeError` instead
  of the file's own `DivergenceError` posture.
- **P11 [low, inference]** The library skips head/tail ids when committing
  resolutions, so a message folded mid-window can keep a stale non-zero
  resolution when it later enters a head/tail window → premature folding of
  verbatim ground. Investigate against the installed library; filter or
  document.

## Part 4 — Engine, bridge, GUI-row completeness

Files: `src/index.ts`, `src/apply.ts`, `src/bridge.ts`, `src/config.ts`,
`packages/client/ui-conversation` (memory row), tests. Runs after Part 3.

- **P6 [medium]** Restore the documented multi-op loop: `index.ts` applies
  `planFolds(...)[0]` and silently discards the rest. One bracket per pass
  (one `compactionId`, ops inside) per the implementation doc; only safe after
  P1/P2/P5. Decide and document fold cadence.
- **E1 [medium]** `/compact` writes a bracket owned by a closed turn:
  `currentTurn` returns the newest `turn/start` even after its `turn/end`, and
  the compaction invariant rejects that shape. Use the pre-step payload's
  `turn`/`step` inside a turn; pass `turn: null` for a standalone bracket on an
  idle agent (`applyFold` already supports it; `compaction-basic` is the
  reference). Also fixes the hardcoded `step: 0` (P10).
- **E2 [medium]** No abort plumbing anywhere: the bridge stream never sets
  `GenerateOptions.signal`, `foldPass` takes no signal, `compactNow` ignores
  the maintenance signal — in-flight compression keeps streaming and paying
  after turn abort, and `/compact` cannot be cancelled. The compaction seam's
  contract requires forwarding. Wire `AbortSignal.any` where two signals meet.
- **E3 [medium]** `runtime.known.set` happens before `session.append`; a
  record the log refuses is abandoned yet marked announced, so the
  recollection is permanently absent from the archive. Mark known only after a
  successful append.
- **E14 [medium]** `compactIfNeeded`/`compactNow` don't convert throws to
  `ManualCompactionError`; a `DivergenceError` escapes `/compact` as an
  unexpected error, against the base-class contract.
- **E4 [medium-low]** `syncToolDefinitions` re-pushes every pass with no
  change check and can never retract; `setSystemPrompt` is never called even
  though the session's request header carries it and the library's refusal
  behavior reads it. Diff before pushing; push the system prompt once per
  change.
- **E6 [low]** One usage record per tick keeps only the last call's usage
  while the attempt counter counts every streaming call — refusal-ladder ticks
  under-report spend. Account per call.
- **E5 [low]** Provenance drift: the recollection's voice freezes at open
  (`compressionModel: route.model`) but the fold node's provider/model comes
  from the current pass's route. Stamp from the same source as the voice.
- **E7 [low]** Config validation: the number knobs carry no `.min`/`.step`;
  a negative reserve inflates the budget.
- **E9 [low]** Dead branch (`affordable <= budget.maxTokens` is unreachable
  while library grace ≥ 0) and a unit-mismatched warn (`actual` is a
  usable-budget figure printed against a total budget).
- **E10 [low]** Bridge crash path: `withName(blocks[0])` dereferences the
  first block when every block mapped to null (e.g. only `redacted_thinking`).
- **E11 [low, decision]** `describeJsonFailures` (~60 lines) diagnoses an
  "impossible" condition and can itself throw (null-prototype `constructor`,
  cyclic values) into the un-awaited tick chain. Constraint 2 says cut it to
  an `isJsonValue` pre-check plus warn; hardening is the fallback.
- **E12 [decision]** When `compile` refuses, the pass returns before
  `kickTick` — a session wedged over budget stops forming memory entirely,
  so its floor never improves. Recommend kicking the tick anyway.
- **G1 [medium, constraint 1]** A call that fails before streaming any text
  leaves no GUI row: the bridge only console-warns and the engine drops the
  empty terminal flush. Design: append a terminal `memory-progress` record
  for the attempt (done, error noted) so the row settles visibly; the
  `AutobioMemoryNodeView` renders the failed state. Also resolve G3: the
  progress event declares `usage?` but nothing writes it — write it or drop
  the field.

## Part 5 — Documentation alignment + final verification

- Package `README.md`: still describes `previewContext`-based planning,
  catch-up ticks on the inference thread, chained widening with pass refusal,
  "renders nothing" for the memory record, and a divergence policy opposite to
  the code — all five are deleted mechanisms or inverted claims.
- `src/types.ts` JSDoc: claims this build never appends
  `autobio/memory-progress`; it does. Regenerate `docs/persistence-catalog.*`
  from the source (both locales — check `docs/i18n/README.md` pairing rules).
- `CONNECTOME-LOG-NATIVE-PLAN.md`: status still says pre-implementation; the
  `dshSeq`-deletion claim is wrong (the stamp is load-bearing).
- `CONNECTOME-LOG-NATIVE-IMPLEMENTATION.md`: line-count table stale; tick
  ordering (kickTick runs after compile, correctly — doc says before);
  `applyFolds` plural; the bridge's `splitMixedToolMessages` call (the library
  splits upstream — effect satisfied, mechanism claim wrong); store method
  list (`sync`/`close`/`isClosed`, `updateStateStrategy`); `currentBranch`
  rationale (library compares by `.name`, not identity); the zero-block skip;
  the "fold nodes always carry `[Recall <id>]`" claim (header appears only on
  the text fallback).
- Final verification: full package suite; repo lint and typecheck;
  `verify-export-jsdoc` / `verify-package-invariants` if wired; the two
  empirical smokes (reopen merged pyramid → zero bridge calls; tool-heavy
  session → no `omitted` placeholders) as executable tests, not one-offs.

## Open decisions (make them in the named part, record the outcome in the doc)

1. **Reserve semantics (Part 4)** — `computeBudget` sets
   `maxTokens = window − reserve` and `reserveForResponse = reserve`, and the
   library subtracts the reserve again: the effective live ceiling is
   `window − 2·reserve`, not `operatingWindowTokens` as the config docs say.
   Either make the configured window the true ceiling or keep the conservative
   double-subtract and fix the docs. Failure direction of the status quo is a
   slightly early fold, not an overflow.
2. **Zero-block events (Part 1, S10)** — skip or store; either way id
   determinism must hold and the rule needs a test.
3. **`describeJsonFailures` (Part 4, E11)** — cut to pre-check + warn
   (recommended) or harden the walker.
4. **Tick on refused compile (Part 4, E12)** — kick anyway (recommended).
5. **Failed-call row shape (Part 4, G1)** — terminal progress record with an
   error marker, vs a new field; keep the event vocabulary minimal.

## Do not "fix" (checked and sound)

- The store shim's core: method set, redact exclusivity, `registerState`
  throw-on-reregister, the Proxy drift alarm, `max suffix + 1` counter rule,
  branch-object stability. The omitted tree guard is provably unreachable
  (mint-preimage touches `treeGet`/`storeBlob` before registering the slot);
  `getStateSlice` returning null on an empty window is handled by its only
  caller and test-pinned.
- `plan.ts`'s partition-by-recollection and divergence-throws posture;
  `startSeq`/`endSeq`/`shadowedSeqs` consistency; fold identity round-trip;
  `resolveRange`'s cycle guard.
- The `OverBudgetError` retry arithmetic (provably cannot re-refuse while
  grace ≥ 0); the kickTick-after-compile ordering (the library cuts its queue
  inside `select`).
- The bridge's vocabulary mapping, thinking-strip pricing, and tool
  forwarding; the engine's no-tokenEstimator choice and calibration feeding
  (one sample per process is dropped by construction — harmless, but the docs
  shouldn't claim "exactly right").
- Deletions: no mirror, watermark, `promptOverhead`, applicator, or
  `command-autobio` anywhere. Chronicle ships only transitively via
  `@animalabs/context-manager` (napi prebuilds; acknowledged in the
  implementation doc; worth an upstream note, not a local patch).

## Out of scope (record, don't build)

- Real red-lemma 1.27M-event replay fixture and a real-log property test
  (both promised in the design docs' test plan). Add red-lemma-*shaped*
  scripted fixtures in the relevant parts instead; a real-log replay is a
  separate acceptance harness.
- Upstream asks: public `resolutions` getter; documented `JsStore` injection
  surface; Chronicle value-import pulling the native module transitively.
- `/autobio` runtime toggle (the plan's optional cut; `auto` is
  constructor-only today).
- Cross-process session ownership (plan pre-build item 5): the scratch store
  made the archive LOCK irrelevant; concurrent log writers are a session-layer
  question, not this package's.
