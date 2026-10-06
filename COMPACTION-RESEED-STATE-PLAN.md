# Fold ping-pong, part 2: the picker re-decides from scratch on every rebuild

Status: **implemented (both fixes landed, 2026-10-06).** Step 1's one-way fold fix and Step 2's
`session/disposed` lifetime swap are in `packages/compaction/compaction-autobiographical` with the
§5 tests; §3 remains the record of the alternation question, to be reopened only if the symptom
survives. Written 2026-10-06 as a handoff to a fresh session.
Read `COMPACTION-FOLD-PINGPONG-PLAN.md` first — it carries the log evidence, the planner-level root
cause, and the one-way-fold fix. This document corrects one of its open questions (§9), adds a second
verified layer underneath it (the strategy's decision state is discarded on every runtime rebuild), and
records what is still unknown.

Claim markers follow the original: **[read]** = verified in cited source · **[log]** = verified by
scanning a session log · **[probe]** = verified by running a controlled experiment · **[inference]** =
reasoned, not observed.

## 0. Why this document exists

A third session (the one investigating the ping-pong) hit the same bug while the investigation was
underway — its log should be scanned for duplicate `compaction/start` ids the same way the original
plan scanned `ee96f6f9`, and added to the damaged-sessions list (original §8). The user could no longer
read the GUI; this file is the handoff.

## 1. Correction to the original plan's §9 ("why did resolutions flip")

The original plan left open why the picker's committed resolutions flipped L2→L1→L2 for the run whose
L1s were merged into `autobio:L2-6`. One theory from the investigation — "the re-seeded store is
surface-only, so pressure collapses after a fold" — is **wrong**. `seedFromLog`'s module header states
the opposite **[read]** `packages/compaction/compaction-autobiographical/src/seed.ts:6-11`:

> History replay — walk the log's append events and append each one's derived message to the
> `messages` slot, in seq order. Replacements are skipped: a fold node is not mirrored, so the
> strategy replans over the originals it stands for.

The re-seeded store holds the full raw history, not `[Recall]` nodes. Live operation matches:
`appendSurfaceNode` **[read]** `seed.ts` (the `export function appendSurfaceNode` body) only calls
`manager.addMessage`, and nothing in the package calls `removeMessage` (grep of
`packages/compaction/compaction-autobiographical/src/` finds the word only in a `store.ts:255`
comment). The store the picker sees is append-only and complete, live and after reseed.

## 2. What actually differs per rebuild: the decision state is thrown away

**2.1 Runtimes are disposable and rebuilt from the log.** The engine caches one runtime per session id
**[read]** `src/index.ts:580-595` (`runtimeFor`) and drops it on `agent/disposed`
**[read]** `src/index.ts:218-219`. The next fold pass re-opens: `openRuntime` builds a fresh store,
`seedFromLog` replays the log, `ContextManager.open` starts a fresh strategy
**[read]** `src/index.ts:598-640`.

**2.2 The library persists its decision state in slots the rebuild throws away.** On load, the
`AutobiographicalStrategy` registers and reads back chunks, summaries, counter, merge queue, merge
quarantine, pins, resolutions, locks, calibration, and kv-unified receipts **[read]** installed copy
`tmp/anima-spike/node_modules/@animalabs/context-manager/src/strategies/autobiographical.ts` —
slot ids at `:1057-1082` (`resolutionsStateId` at `:1079`, `calibrationStateId` at `:1081`),
registration at `:1825-1898` (the library registers these itself, in a try/catch that treats a repeat
as success — which is why `LogStore.registerState` throws on duplicates), the load sequence at
`:1925-2084` (`getStateJson` for each slot), persistence at `:2092-2133` (`setStateJson`).

Seeding pre-registers and fills exactly `messages`, `default/autobio:summaries`,
`default/autobio:counter` **[read]** `src/store.ts:62-68`, `src/seed.ts:76-79`. So every
dispose→rebuild re-opens the strategy with the full message history and the full pyramid
(rebuilt from `autobio/memory` events **[read]** `seed.ts:12-17`) but with **empty resolutions,
empty kv receipts, empty calibration, no locks, no pins**. Those slots are precisely the library's
hysteresis: committed per-message levels, the kv-stable trust region that holds them steady between
compiles, and the calibrated token estimates the budget is derived from. Without them the picker
re-decides every level from scratch on each rebuild, over estimates that start from scratch too.

**2.3 The library itself does not thrash.** Probe: `tmp/anima-spike/resflip.mjs` (runnable;
`tmp/anima-spike` has `@animalabs/context-manager@0.10.1` installed with deps — `ref/context-manager`
has neither `node_modules` nor `dist`, so use the playground, not the ref checkout). It drives a real
`AutobiographicalStrategy` (kv-stable, adaptive resolution, MockAdapter) through 60 turns of
append-only growth, compiling every turn and snapshotting the protected `resolutions` map.
Result **[probe]**: 84 messages changed level, all escalations (L1→L2→L3→L4), **zero de-escalations**.
Under continuous operation from a cold start the picker is monotone — which rules out one library
failure mode, but only one: the probe does not cover a seeded pyramid with empty receipts (§3
candidate 4), a calibration reset, or a shrinking budget, so it does not by itself clear the library
of the L2→L1 flips.

## 3. What is still unknown (no longer fix-gating)

The alternation driver: why a fresh picker's decision differed between consecutive rebuilds (candidates
from the investigation: live messages shifting the budget split, calibration reset, new tail
recollections from `kickTick` **[read]** `src/index.ts:334`, or the seeded-pyramid × empty-receipts
interaction on the initial pick). Under the chosen fix (§4) the runtime is not rebuilt, so the fresh
picker never appears and the question does not gate anything. It stays recorded in case the symptom
survives the fix — that would mean the driver is live, not rebuild-borne.

## 4. Plan

Design rule for this package: it is a pass-through. The wrapper mirrors the log into the library's
store and hands the library its own strategy; it does not duplicate, stash, or re-derive library
state. Any fix that makes the wrapper persist the library's decision slots on the library's behalf is
rejected on that rule alone.

### Step 1 — Land the one-way-fold fix (invariant net)

The original plan's change 1 (`COMPACTION-FOLD-PINGPONG-PLAN.md` §5-6, four tests included) lands
first and independently: a claim is dropped when a landed ancestor already represents its ground, so a
fold can never push an ancestor's ground back down — unfolds are physically impossible in the log, so
every fold decision is one-way and the ping-pong has no cycle to run. The investigation's standing
recommendation was the surface-facts coverage test in the claims loop **[read]** `src/plan.ts:226-242`
(kill a claim whose live keys sit inside a fold node standing for strictly more ground) rather than a
`mergedInto` walk — it needs no pointer dependency and re-derives nothing the surface doesn't already
know. If a pointer walk is used instead, it must go through `getSummaryParentId`
(`s.parentId ?? s.mergedInto`), never `mergedInto` alone **[read]**
`ref/context-manager/src/types/strategy.ts` (`getSummaryParentId`).

### Step 2 — Stop rebuilding the runtime: dispose on `session/disposed`, not `agent/disposed`

The whole fix is the runtime's lifetime. The runtime mirrors a session's log; today it is dropped when
any *agent* for that session leaves the registry (`src/index.ts:218-219`). An agent's lifetime is
shorter than its session's — disposal means the agent left the registry, not that the session ended
**[read]** `packages/core/agent/README.md:51` — so every agent turnover discards the picker state for a
session that lives on (the damaged log's ~2-minute cycle is consistent with that **[inference]**; the
exact dispose trigger was never pinned down, and with this fix it no longer needs to be). Swap the
listener to `session/disposed` **[read]** `packages/core/session/src/index.ts:64`, dispatch at
`:1002`, which fires when the session itself leaves the registry. No new machinery, no LRU, no slot
persistence: the strategy keeps its own resolutions, receipts, and calibration in its own memory
because we stop killing it. The store is already scratch rebuilt from the log, so a session disposed
and later re-opened re-seeds exactly as today — that path is untouched. The comment above the current listener
(`src/index.ts:214-217`) and the lifecycle bullet in the package README describe the old lifetime and
move with the change.

Two accepted trade-offs, both smaller than the machinery they replace:

- **Memory**: a runtime is held per session that ever folded, until the session unloads (or plugin
  shutdown clears the map, `ctx.effect` at `src/index.ts:221`). Sessions already have a managed
  lifetime in the registry, so this needs no cap of our own. If a real memory problem shows up,
  revisit then — do not pre-build one.
- **Stale route**: `openRuntime` captures `route.model` as the compression model at open, and eager
  disposal used to refresh it incidentally. A model switch mid-session now reaches memory formation
  only after the session reloads. Acceptable; do not add a route-change reopen unless it bites.

**Rejected: Fix A (persist resolutions/receipts/locks engine-side).** It makes the wrapper a second
persistence layer for library-internal state: hardcoded slot ids (`default/autobio:resolutions`,
`default/kvunified:presentation-receipt`), an assumption that store message ids stay stable across
rebuilds, and an in-memory stash that a server restart silently discards. It is exactly the complexity
this package accumulates when it stops passing the library's own machinery through.

### Step 3 — Tests

The four tests from the original plan §6, plus lifetime tests for step 2: `agent/disposed` leaves the
cached runtime in place (a later pass reuses it, no reseed), `session/disposed` drops it (a later pass
re-seeds from the log). The existing disposal tests at `tests/index.spec.ts:775-830` emit
`agent/disposed` and will need updating to the new listener. The reseed-stability scenario from the
earlier draft (fold, dispose, rebuild, fold again) is no longer the fix's contract — keep one as a
regression test for seeding only if it is cheap, asserting the second pass emits no op for
already-represented ground.

### Step 4 — Damaged sessions

Original plan §8 covers `ee96f6f9` and `f053f4c6`. Add this investigation's session (§0). The choice
between tolerant client rendering and hand-dropping the degenerate brackets is still open.

## 5. Working notes for the fresh session

- Playground for library experiments: `tmp/anima-spike/` (`npm` deps installed; `resflip.mjs` is the
  resolution-stability probe, still useful if the alternation survives the fix and §3 reopens).
- Library source for reading: `ref/context-manager/` (matches installed 0.10.1) or the installed copy
  under `tmp/anima-spike/node_modules/@animalabs/context-manager/src/`.
- The package under fix: `packages/compaction/compaction-autobiographical/` — planner `src/plan.ts`,
  fold application `src/apply.ts`, seeding `src/seed.ts`, engine `src/index.ts`, store `src/store.ts`.
- The preflight replacement that made the cycle reachable is commit `750a3e7` (2026-10-05, already
  committed despite the original plan's header saying "uncommitted") **[read]**.
