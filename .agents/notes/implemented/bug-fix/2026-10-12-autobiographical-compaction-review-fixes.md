# Agent Note: Autobiographical compaction review fixes

Status: implemented

English | [中文](2026-10-12-autobiographical-compaction-review-fixes.zh.md)

## Problem

A read-only review of [the autobiographical backend](../feature/2026-03-02-autobiographical-compaction-backend.md), confirmed by probes against the real library, found defects in the integration with `@animalabs/context-manager` 0.10.1. The worst stopped memory formation for a session until the host restarted. The bridge answered every failure except `TRANSPORT` and `TIMEOUT` as an empty `abort` response, so one rate limit, server error or cancelled turn quarantined the chunk. The library then put that chunk back at the head of its queue on every compile, and the engine's one tick per pass spent itself on the chunk without a call, forming nothing again. Other defects lost memory content from the surface: a later fold could replace an earlier recollection's node; live messages longer than twice the chunk target were sharded into store rows the engine mapped only partly; and seeded pyramids three levels deep cited their leaves twice and linked children to the wrong parent.

## Decision

**The bridge reports failures the way membrane's `complete()` does.** A cancellation, or a code the routed provider's retry policy retries (`ctx.llm.providerRetryPolicy`, read when the runtime opens), is thrown as a retryable `MembraneError`. The library takes that as transient: it keeps a chunk or merge queued and counts no attempt. Any other failure is still answered as an empty `abort` response, because the library rethrows a thrown first L1 call without accounting, and a deterministic failure would then hold the queue's head forever; an unusable answer goes through its bounded quarantine instead. The release of merge quarantines on the next user message is gone: cancellations no longer reach quarantine, and what does is a verdict that retrying repeats. The quarantine lift for a tick that saw a transport failure now covers every retryable failure. The bridge also reports the whole prompt, cache reads and writes included, as the call's input.

**A tick moves past queue items that call no model.** `driveTick` ticks again while a tick consumed a queue item without starting a call, and stops at the first call or when the queues stop shrinking, so a pass still makes at most one call. A tick queued behind a call that outlived its turn is skipped when its signal has already fired.

**Planning never takes another recollection's node off the surface.** Ground under another recollection's node belongs to that node unless the claim owns the node's whole footprint, and a claim with such a node inside its span waits. A claim whose ground another node covers at the same or a coarser level is represented, so folds only coarsen and a flipping resolution cannot alternate two nodes. The backward walk runs only while the span holds a result whose call it does not, takes every node between it and the call, and stops at a landed fold node. `foldIdOf` reads the recall header only from a replacement event, and a fold node lands the stored response's text blocks, not the library's `thinking` blocks.

**Live messages are not sharded.** The engine's strategy overrides `chunkIngressMessage` to return null, so every log event is one store row, as seeding has always written it.

**Seeding rebuilds the pyramid the library builds.** A recollection's children are the outermost lower-level recollections inside its interval, chosen widest first and cited in position order, and each child's `mergedInto` names its direct parent.

**Refusals are classified.** An `OverBudgetError` whose `actual` is within its budget is structural and is not retried; a size refusal is retried only while the reachable size fits the routed window. `compactNow()` reports every refusal as `ManualCompactionError('summary')`, and a request cancelled before folds land lands nothing and rethrows its own reason.

**Disposal retires a runtime.** Its in-flight and queued calls are cancelled, and it writes no rows or records afterwards. Attempt numbers resume past every attempt the log names, live rows included; accumulated usage is cleared only once its record is durable; and `@animalabs/context-manager` is pinned to exactly `0.10.1`, because the engine reads the strategy's protected state.

## Alternatives considered

**Throw every failure, retryable or not.** Rejected: the library's L1 path rethrows a thrown first call with no attempt accounting, so a deterministic failure would hold the queue's head and stall formation the same way the quarantine did.

**Keep one tick per pass and release chunk quarantines on resume.** Rejected: it treats the symptom, and any quarantine the release rules miss would still hold the queue's head.

**Map every shard to its message's seq.** Rejected: one replace cannot split a log event, so recollections of a message's other shards could never land, and seeding would have to reproduce the library's sharding to match.

**Drop retries of size refusals entirely.** Rejected: a size refusal still means the strategy reached a smaller layout, and landing it within the routed window is what keeps a long session usable.

## Consequences

Memory formation recovers from cancellations, rate limits and server errors without a restart, and a quarantined chunk no longer blocks the chunks behind it. A deterministic failure still retires its span until restart, which is the library's own bounded policy. Recollections stay on the surface, a very long paste becomes one oversized chunk, and fold nodes from reasoning models are priced at their text. A manual `/compact` reports why it folded nothing instead of "No compactable history yet". The library-side contract defect — structural refusals raised as `OverBudgetError` with `actual` within the budget — is recorded for an upstream report. Coverage: `bridge.spec.ts` pins the failure classification; `engine.spec.ts` the retryable-failure recovery, the cancelled turn, and the skip past a quarantined chunk; `plan.spec.ts` the node-preserving, one-way and pair-safe planning cases; `acceptance-reopen.spec.ts` the rebuilt pyramid; and `index.spec.ts` refusals, cancellation, disposal, attempts, usage and the unsharded message. No runnable example composes this backend, so no keyless snapshot covers it.
