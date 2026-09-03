# Agent Note: The compaction instruction prioritizes comprehensive detail over brevity

Status: implemented

English | [中文](2026-09-01-comprehensive-compaction-checkpoints.zh.md)

## Problem

`COMPACTION_INSTRUCTION` asked the summarizer to "condense" the conversation into "terse bullets" in "concise English engineering prose", and every one of those pushes traded coverage for size: investigations, intermediate steps, wrong turns, learnings, and hypotheses were routinely summarized away. The section template had no home for a chronological record of actions or for suspected-but-unverified explanations, so even a compliant summary could not preserve them. Because checkpoints merge on later cycles, whatever the first summary dropped was lost permanently.

## Decision

The instruction's stated priority is inverted: comprehensiveness over brevity. It opens with "Completeness is the priority: it is far better to include a detail than to drop it", and the `## Work Log` section requires a chronological account of everything done — what was investigated, read, or explored, commands run, files changed with exact paths, checks executed with their results — with the reason for each action. `## Things Learned` collects discovered facts and corrected assumptions, `## Footguns and Pitfalls` preserves recurring traps — project- or environment-specific quirks, commands or approaches that break or mislead, flaky steps and their workarounds, and conventions that are easy to violate — so they are not repeated after a compaction, `## Decisions and Rationale` records who decided what and why including rejected alternatives, `## Leading Theories` preserves suspected causes with their evidence for possible later investigation, and `## Files and Code` requires line numbers. The prior-checkpoint merge rule no longer tells the model to "drop stale facts"; it directs carrying the prior work log, learnings, footguns, and still-relevant facts forward while refreshing the state sections from the later conversation. The brevity direction ("terse bullets, not prose paragraphs", "Write concise English engineering prose") is replaced by permission for bullets to run to several sentences when the detail warrants it.

The placement contract of the [prefix-cache note](2026-07-21-compaction-summary-prefix-cache-reuse.md) is unchanged: the instruction is still the trailing user message appended to the byte-identical replayed prefix, so KV-cache reuse is unaffected. The English-register requirement of the [English-checkpoints note](2026-07-31-english-compaction-checkpoints.md) stays in the opening sentence, which now carries both policies ("…a comprehensive, detailed checkpoint in English…").

## Alternatives considered

- **Keep the brevity pushes and add only a work-log section** — rejected: "condense" and "concise" instructions override section presence in practice; a model asked to be terse prunes the new section first.
- **Cap the summary's size with an explicit budget** — rejected: any budget the instruction states is already enforced by the request's `maxTokens` cap, and a stated budget reintroduces the incentive to prune that this change removes.
- **Let each deployment override the instruction in config** — rejected: the instruction's trailing position and its exact-merge rules are part of the checkpoint contract the [prefix-cache note](2026-07-21-compaction-summary-prefix-cache-reuse.md) owns; a free-form override would let a deployment silently break both.

## Consequences

- Checkpoints grow larger and richer: they retain chronological history, learnings, and hypotheses across cycles instead of collapsing to current state. The durable replacement user message and every later replayed prefix grow accordingly, so context pressure is relieved less aggressively per compaction than a terse summary would achieve.
- Summarization output approaches the `maxTokens` cap (default 8192) more often; the fail-closed `MAX_TOKENS` handling in `finishError` discards a truncated checkpoint rather than landing a partial one, so the failure mode is a skipped compaction, not silent loss.
- Test content assertions in `compaction-basic.spec.ts` and `compaction-loop-repro.spec.ts` track the new rule wording; the `## Primary Request and Intent` heading and the "acting as a compaction engine" opener remain the stable markers the loop repro uses to classify the summarization request.
