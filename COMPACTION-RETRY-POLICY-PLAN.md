# Compaction retry and quarantine policy

Status: **implemented** (`src/index.ts`, tests in `tests/engine.spec.ts`). Superseded the earlier
four-part design in this file's history: the engine's own bounded attempts plus quarantine already
implement the retry/hold-off policy, so nothing needs to steer it — only to release it.

## Problem

A cancelled turn spends a merge's whole attempt budget on calls that abort on arrival. The engine
counts each as a rejection and, at `mergeAttemptLimit ?? 5`, moves the run into quarantine
(`strategies/autobiographical.ts:3741-3800`). A quarantined run is refused by `enqueueMerge`
(`:3681`) and the only automatic exit clears records whose sources are gone or covered (`:3841-3862`)
— so with every source still unmerged the span stays unfolded for the life of the runtime.

Observed live (`/home/bepis/piano`, 2026-10-05):

```
[compaction-autobiographical] compression call ended aborted: ABORTED Request was aborted
[autobiographical] L2 merge attempt 1/5 rejected (unusable_empty, stop=abort) — entry retained for retry
... attempts 2..5, each aborted ...
[merge-quarantine] ⚠ L2 merge over 6 sources quarantined after 5 rejected attempt(s)
```

Both bridge failure routes reach that assessment as one value: `src/bridge.ts:220-223` maps `finish.kind`
`'error'` and `'aborted'` alike to `stopReason: 'abort'`, which the engine then scores `unusable_empty`
(empty text, `:2786`) or `incomplete` (non-empty, `:2791-2793`).

## What shipped

**1. A dead signal kicks no tick** — `src/index.ts:332-334`:

```ts
if (pass.signal?.aborted !== true) this.kickTick(runtime, session, pass.signal)
```

Without it, the pass kicks a tick whose every call aborts immediately, and each one is counted
against the work being retried.

**2. A resumed chat releases what an abort quarantined** — `src/index.ts:320`, method at `:554`:

```ts
private releaseCancelledQuarantine(runtime: Runtime, session: Session): void {
  const asked = newestAsk(session)
  if (asked === runtime.lastAsk) return
  runtime.lastAsk = asked
  for (const record of runtime.strategy.getMergeQuarantineStatus().records) {
    if (record.lastStopReason === 'abort') runtime.strategy.clearMergeQuarantine(record.key)
  }
}
```

## Why that is sufficient

- The policy is the engine's own behaviour, unchanged: bounded attempts = "retry a few times",
  quarantine = "hold off", and `clearMergeQuarantine` = "retry once the chat is going again" — its doc
  states the next `checkMergeThreshold` re-enqueues the run with a fresh attempt budget (`:3813-3817`).
- No classification is added. `MergeQuarantineRecord` already records the reason (`:528-537`), and both
  bridge failure routes land as `abort`, so one string comparison separates a cancelled turn from a
  refusal.
- A refusal keeps its record: `lastStopReason` is `'refusal'`, so it never matches. Refusals stay
  quarantined, which is the wanted behaviour.
- Thrown transport failures need nothing: the engine rethrows those and retries them every tick
  (`:4328`), so they never quarantine.
- The trigger is the newest user message, not a clock: `runtime.lastAsk` is seeded when the runtime
  opens, so a pass in the same conversation never releases work on its own.

## Known limits

- **Chunk quarantine is covered for transport failures only.** A tick that saw a `TRANSPORT`/`TIMEOUT`
  call failure releases the quarantine keys it wrote (`src/index.ts:479`); the wrapper still cannot
  read a record's reason, so the tell is the tick, not the record. A genuine refusal that shares a
  tick with an unrelated transport failure is released once and re-quarantines on a healthy tick.
- **A deterministic error that throws rather than finishes** still retries every tick. The engine's
  guard for it keys off `error.retryable === false` (`:4278-4283`), which DSH errors never carry —
  `HarnessError` has only a `code` (`packages/llm/llm/src/error.ts:16-23`). Pre-existing, unchanged.

## Addendum: connection failures (2026-10-07)

A mid-stream connection failure arrives as a `finish` chunk of kind `error` with code `TRANSPORT`
(pi-ai classifies "Connection error." that way). Mapped to `stopReason: 'abort'` it read as a verdict:
a chunk whose canonical call ended that way quarantined immediately, and one whose fallback rungs died
on the connection quarantined on `provider_error` outcomes — both for the life of the runtime.

Two wrapper-side changes close it:

**1. The bridge throws a transient finish instead of reporting it** — `src/bridge.ts:239`. An `error`
finish carrying a `TRANSPORT` or `TIMEOUT` failure fires the terminal `onText` tap as before, then
throws an `LlmError`. The engine's transient path takes it: the work stays queued and the next pass's
tick retries, one attempt per pass, forever. An `aborted` finish keeps the `abort` stop reason — the
cancelled-turn release above is keyed on it.

**2. A tick that saw a transport failure lifts the quarantine it wrote** — `src/index.ts:479`. The
fallback ladder catches a thrown call per rung (`autobiographical.ts:6042,6152,6236`) rather than
letting it escape, so a genuine verdict plus a dead connection in one tick still exhausts into
quarantine. The tick snapshots `getCompressionQuarantineStatus().keys` before it runs; after it
settles, any new key from a tick whose `onText` tap reported a transient failure is cleared through
`clearCompressionRefusalQuarantine`. The record names no reason the wrapper can read, so the tick is
the tell: a refusal sharing the tick is released once, retries, and re-quarantines on a healthy tick —
the price of keeping a connection failure from retiring a span for good. Quarantines from before the
fix are not retroactively cleared.

Verified: `npx vitest run packages/compaction/compaction-autobiographical` — 233 passing (four new:
the throw, the terminal tap under it, the lift with its refusal control, and a down-then-healed
session folding without intervention); `tsc -b` and oxlint clean on the changed files.

## Deferred

## Verification

- `npx vitest run packages/compaction/compaction-autobiographical` — 224 passing (two new).
- The two new tests were confirmed red with the fix reverted in place and green with it applied. The
  release test anchors both records on a real unmerged recollection so the engine's own paid-off sweep
  cannot empty the map and make the assertion pass for the wrong reason.
- `npx tsc -b packages/compaction/compaction-autobiographical` — exit 0; `run-oxlint` on both changed
  files — 0 warnings, 0 errors.
- `index.spec.ts` reports one unhandled rejection (`cannot create effect on inactive context`,
  `scripts/test-invariants.ts:162`) that reproduces with the changed files restored from HEAD, so it
  predates this change.

## Deferred

Considered and not built, in the order they would matter: an abort-aware outcome in the engine so a
cancelled call is not scored as a disposition at all (one dependency patch, covers the chunk path
too); `retryable`/`type` synthesis on thrown bridge errors so the engine's deterministic and
server-streak branches become reachable; and a per-entry hold-off, which the engine has no API for.
