# Fold ping-pong: duplicate compaction ids and unloadable history

Status: **diagnosed, not fixed.** Written 2026-10-06 against the working tree (`src/apply.ts` carries
the uncommitted fold-citation fix from 2026-10-05; nothing else in this package is modified).

Scope: the log-native fold planner in `packages/compaction/compaction-autobiographical` and the
client-side history loader that rejects its output.

Claim markers: **[read]** = verified by reading the cited source; **[log]** = verified by scanning a
session log; **[not verified]** = stated as a question, not a fact.

## 1. Symptom

**User-visible.** Opening the session fails:

```
Failed to load history: conversation Context 21:trajectory-compactionautobio:L2-6 received more than one start Match (internal)
```

That string is `chat.loadError` **[read]** `packages/client/ui-conversation/src/client/locales.ts:269`
(`'Failed to load history: {message} ({code})'`), carrying a message thrown by the conversation
assembler **[read]** `packages/client/runtime/src/client/sessions/conversation-assembler.ts:396` and
again at `:483` — `acceptMatch` at `:387` asserts **one** `start` match per conversation context, and a
second `compaction/start` for the same id breaks it. The `trajectory-compaction` context and its
`start` match come from **[read]** `packages/client/ui-trajectory/src/client/trajectory-compaction-definition.ts:80-95`
(`kind: 'trajectory-compaction'` at `:81`; a `start` match requires the event to be `compaction/start`,
`:91-95`). The key renders without a separator (`21:trajectory-compactionautobio:L2-6`), which is only
cosmetic. One duplicated id fails the **whole** history load, not just that bracket.

**In the log.** A session can hold several `compaction/start` events with the same `compactionId`, each
with its own `summary`/`end`. Nothing rejects that: the compaction invariant validates the id's shape
(`packages/compaction/compaction/src/invariant.ts:155-156`), that a checkpoint/summary/end has a
matching open start (`:68`, `:178`, `:205`), and that a bracket does not cross a turn boundary; a
grep of that file for `already`/`duplicate` finds no uniqueness rule **[read]**. The library's
`session/end-seed` handling (`:80-90`) treats an open start as stale rather than duplicated.

**Engine behaviour.** The engine keeps folding the same two recollections over one another. Each round
writes a full bracket — `compaction/start`, `compaction/summary` carrying the recollection's content,
the replacement node, `compaction/end` **[read]** `src/apply.ts:172`, `:174`, `:187-196`, `:203` — and
replaces a node with a node at the same surface position, so the represented context never changes.
There is no alarm for it: the engine's quarantine paths are unrelated, and the fold pass reports
success.

## 2. Evidence

### 2.1 `session-ee96f6f9` (cwd `/home/bepis/prog/deepseek-harness-mobile`) — [log]

`~/.dsh/sessions/--home-bepis-prog-deepseek-harness-mobile--/session-ee96f6f9-e34c-4ab1-8c87-1d790d712c99/session.jsonl.zstd`
· created 10-05 20:10:09 · last event 10-06 13:29:47 `session/end-seed` · turn 4 ended `interrupted`.

Every fold id appears once except two, which appear **four times each**: `autobio:L1-0` and
`autobio:L2-6`. The repeats are single-node folds whose ranges are each the previous repeat's own node
seq — a closed cycle:

| time | id | `shadowedRange` | nodes | replaced |
| --- | --- | --- | --- | --- |
| 20:16:38 | `autobio:L1-0` | 7..201 | 7 | real fold |
| 20:18:44 | `autobio:L1-1` | 315..317 | 2 | real fold |
| 20:20:29 | `autobio:L1-2` | 361..3446 | 15 | real fold |
| 20:23:16 | `autobio:L1-3` | 3509..9729 | 22 | real fold |
| 20:30:55 | `autobio:L2-6` | 9733..16440 | 17 | real fold → node 32177 |
| 20:32:00 | `autobio:L1-0` | 32177..32177 | 1 | the `L2-6` node |
| 20:34:20 | `autobio:L2-6` | 34019..34019 | 1 | the `L1-0` node |
| 20:38:14 | `autobio:L1-0` | 38309..38309 | 1 | the `L2-6` node |
| 20:38:14 | `autobio:L1-8` | 22196..32173 | 12 | real fold |
| 20:38:53 | `autobio:L2-6` | 43919..43919 | 1 | the `L1-0` node |
| 20:42:03 | `autobio:L1-0` | 45307..45307 | 1 | the `L2-6` node |
| 20:42:25 | `autobio:L2-6` | 48742..48742 | 1 | the `L1-0` node |
| … | `L1-9`, `L1-10`, `L1-12`, `L1-13`, `L1-15`, `L1-16` | | | real folds, interleaved |

The chain is exact: each single-node range equals the seq of the node the previous single-node fold
created (`32177` → `34019` → `38309` → `43919` → `45307` → `48742`), roughly every two minutes for
twenty-two minutes, alongside genuine folds at other positions.

### 2.2 `f053f4c6-c69a-44fd-8186-9ef1d61eef02` — [log]

Same workspace, folds 18:00–18:18: real `L1-0`…`L1-5`, `autobio:L2-6` at 18:13 over 1203..20080, then
`autobio:L1-0` at 18:18 over `22300..22300`, one node. Same first step of the cycle.

Both are later than the fold-citation fix that was built into `lib/` at 2026-10-05 17:14 and loaded by
the running server.

## 3. Root cause

Two defects, in one place: the planner asks "is my own node standing there?" when the question it needs
answered is "is this ground already represented?".

**3.1 The documented rule is missing its second half.** `plan.ts:278-285` states the rule and its
reasoning:

> A recollection the pyramid has merged upward is *not* skipped here: its `mergedInto` records
> formation, not representation — until the parent's own fold lands, the child's node is still what the
> surface shows for that ground, and the messages under it still resolve at the child's level.
> **Once the parent lands, those nodes are gone and the question never comes up, so the pointer never
> needs reading either way.** (`:284-285`)

The first sentence is implemented: a merged child is not skipped (its `mergedInto` is not consulted —
`mergedInto` appears nowhere else in the file **[read]**, `grep -n mergedInto src/plan.ts` → `:281` only).
The second is false. When the parent's fold lands, the child's messages still carry the committed
resolution the picker gave them at the child's level, so the claims loop still builds a claim for the
child:

- message resolves to level 1 → `standingFor` returns `L1-0` **[read]** `plan.ts:230`, `:306-312`
- `place.get(seq)` resolves that message's ground to the position now held by the **parent's** node
  **[read]** `plan.ts:238`, populated at `:351` from `annotateSurface`'s coverage expansion
- claim `L1-0` is built **[read]** `plan.ts:235-241`, ordered at `:247`, landed at `:258`

**3.2 The settled test compares node identity.** `land()`'s "nothing to do" state is
**[read]** `plan.ts:450-454`:

```ts
let settled = true
for (const position of span) {
  if (!this.own(position)) settled = false
}
if (settled) return []
```

with `own()` at `:394-396` testing `this.surface[position].foldId === this.claim.summary.id`. The
comment above it already names the failure: *"the surface carrying this recollection's own landed node
and nothing else is the settled state: … folding again would trade the two places forever"*. But in the
cycle the span carries the **other** recollection's node, so `own()` is false for both sides: `L1-0`
folds the `L2-6` node, then `L2-6`'s claim finds an `L1-0` node in its span and folds back. Node
identity cannot see that the position is already represented.

**3.3 Why the fold is legal, not refused.** The op that lands carries `coveredNodes = [32177]` — just the
live node's seq — because `nodesUnder` (`plan.ts:624-626`) expands only when `owns()` (`:606-612`)
holds, and `owns` for a fold node requires its whole coverage to be inside the claimant's keys. The
parent stands for *more* ground than the child claims, so the expansion is empty, the positional range
holds one live node, and the preflight is satisfied **[read]** `src/apply.ts:57-76`.

## 4. Why it became reachable now

The cycle needs an L2 fold to land over ground an L1 already replaced. That op is exactly the class the
previous preflight refused: `L1-1`'s node (seq 12921) and `L1-2`'s node (14222) sit inside `L2-6`'s span
(9733..16440) and their coverage lies inside `L2-6`'s keys, so `nodesUnder` was non-empty, `coveredNodes`
named ground no longer on the surface, and `assertFoldOpsApply` threw — the same failure that had the
piano session stuck at four folds for eighty minutes.

The working tree replaces that check with the session's own containment rule **[read]** `src/apply.ts:63-76`
against **[read]** `packages/core/session/src/surface.ts:239-242`, `:250-257`, `:264`. With it, the L2
fold lands, the cycle's precondition appears, and the missing half of the rule at `plan.ts:284-285` is
what the run then hits. So: the citation fix is the enabler; the ping-pong is a pre-existing gap in
`plan.ts` that the wedge had made unreachable. [not verified] whether any session before 2026-10-05
17:14 shows the same duplicate ids; the scan that would answer it was interrupted.

## 5. Fix

**Design statement.** A recollection's claim is live only while the surface does not already show a
landed recollection that stands for the same ground. The pyramid already records that relation
(`mergedInto`), so the claim is dropped where it is built rather than suppressed at the end.

**Change 1 — drop the claim at the source.** In the claims loop, immediately after `standingFor`
**[read]** `plan.ts:230`, skip the message's contribution when an ancestor of that recollection has a
landed node on the surface:

```ts
const summary = standingFor(ranges, level, seq)
if (represented(surface, inputs, summary)) continue
```

`represented` walks `summary.mergedInto` through `inputs.summaries` (library type
`@animalabs/context-manager` `types/strategy.ts:1309`; set on merge at
`strategies/autobiographical.ts:3631`, called at `:7488`; re-recorded from the log by this package at
`src/seed.ts:178-196`, deepest parent at `:194`) and returns true when any ancestor id appears as a
surface node's `foldId` **[read]** `plan.ts:348`, `:81`.

It must sit in the claims loop and **not** in `standing()` (`:275-296`): skipping there would leave the
messages resolving at that level with no standing entry, and `standingFor` throws on exactly that
**[read]** `plan.ts:310` — the wedged-pass failure mode this package already fights.

Four states, all correct:

| child landed | ancestor landed | result |
| --- | --- | --- |
| yes | yes | claim dropped — the ancestor's node stands for the ground ✔ the cycle |
| yes | no | claim kept, its own node is the settled state (`:450-454`) ✔ nothing to do |
| no | yes | claim dropped — the ancestor's fold already replaced that raw ground ✔ |
| no | no | claim kept — this is the fold that must land ✔ |

Children that never landed are the case that makes a level comparison insufficient: the ancestor's fold
consumed raw ground that the child would otherwise fold later.

### Rejected alternatives

- **Level-aware settled test in `land()`** (settle when every node in the span is a fold node at a level
  ≥ the claim's). It works for the observed cycle, but it suppresses after the fact, needs a new level
  on `SurfaceNode` (`:78-87`, which carries only `foldId`), and leaves the mixed span — an ancestor's
  node beside raw ground — inside `land()`'s `v8 ignore` "cannot arise" case (`:472-475`), where
  `shadowedSeqs` and `coveredNodes` would disagree about the node in the middle.
- **Coverage-only test** (settle when the span's nodes already cover the claim's keys). Wrong: the
  wanted consolidation, an L2 folding L1 nodes, also satisfies it, and would stop landing.
- **Skip merged children in `standing()`** — see above: turns the cycle into a permanent
  `DivergenceError` on every pass.

## 6. Tests

`packages/compaction/compaction-autobiographical/tests/plan.spec.ts` already holds both halves of the
rule around this gap **[read]**: `:337` `lets a merged recollection stand until the fold of its parent
lands`, and `:398` `does not fold a recollection the surface already carries` (the own-node settled
case). Add beside them, using the existing helpers `foldNode` (`:108`), `seeded` (`:125`), `plan`
(`:170`):

1. `stops folding a recollection once a landed parent stands for its ground` — fold `L1-0`, fold `L2-6`
   over it, assert the next plan returns no op for either id. This is the reported cycle.
2. `keeps folding a child whose parent has not landed` — the existing `:337` case, extended to assert the
   op still lands (guards against over-skipping).
3. `stops at the top of a chain` — `L1-0` merged into `L2-6` merged into `L3-43`, all three landed,
   assert no op; the ancestor walk, not a parent check.
4. `drops a claim whose ground a landed parent already replaced, though it never landed itself` — the
   third row of the table above.

## 7. Verification

```
npx vitest run packages/compaction/compaction-autobiographical        # package suite, 224 today
npx tsc -b packages/compaction/compaction-autobiographical            # exit 0 today
npx tsx scripts/run-oxlint.ts <changed files>
```

Confirm the new tests fail with change 1 reverted in place, as with the previous fix. Then re-run the
duplicate-id scan below against a fresh session.

**Detection (no alarm exists today).** Duplicate ids are visible only by scanning a log:

```sh
zstd -dc session.jsonl.zstd | python3 -c "
import sys,json,collections
c=collections.Counter(json.loads(l).get('data',{}).get('compactionId') for l in sys.stdin
                      if json.loads(l).get('type')=='compaction/start')
print({k:v for k,v in c.items() if v>1})"
```

## 8. Damaged sessions, separately

Change 1 prevents new cycles. It does not make `session-ee96f6f9` or `f053f4c6` openable, because their
logs already hold the duplicates. Three postures, and this is a policy call rather than part of the fix:

- **Strict (today).** `conversation-assembler.ts:396`, `:483` throw; one duplicate takes the whole
  history view away. `:395` already guards on `context?.start !== undefined`, so the invariant is
  deliberate; `packages/client/runtime/tests/conversation-assembler.client.spec.ts:1043` asserts it.
- **Tolerant.** Keep the first `start` per context and render later ones as ordinary nodes; the session
  opens and the log stays as it is. Costs a rendering rule for a shape nobody should write.
- **Refuse at the write boundary.** A uniqueness rule in `packages/compaction/compaction/src/invariant.ts`
  (which today checks pairing, `:68`, `:178`, `:205`, and boundary crossing, but not uniqueness) would
  surface the duplicate at fold time. It matches the repository's fail-loud rule, but a refused append
  becomes a swallowed warn in `agent/pre-step` and a stalled fold pass — the silent-wedge shape, now
  with a loud origin.

For the two existing logs the practical choices are tolerant rendering or dropping the degenerate
brackets from the log by hand; I have not touched either file.

## 9. Not verified

- Whether any session predating 2026-10-05 17:14 has duplicate ids (scan interrupted).
- Whether the `L1 → L2 → L3` chain reaches the cycle through the same or a second path. The piano
  session held an `L3-43` fold; test 3 above is written to cover the walk either way.
- Whether `session/end-seed` (the last event of `ee96f6f9`) interacts with the cycle — the invariant
  treats an open start as stale there **[read]** `invariant.ts:80-90`, and the cycle's last bracket is
  closed, so nothing suggests it does.
