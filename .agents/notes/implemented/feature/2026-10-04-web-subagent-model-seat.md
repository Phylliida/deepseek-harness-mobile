# Agent Note: Per-session subagent model seat in the Web composer

Status: implemented

English | [中文](2026-10-04-web-subagent-model-seat.zh.md)

## Problem

Delegations from a Web session start on the session's own model unless the delegating model passes an explicit `agentOptions` route per call. A user who wants children on a cheaper or stronger model had no per-session way to say so once: the [session model selector](2026-07-24-web-session-model-selector.md) moves the parent's own route, and the tool parameter must be repeated at every delegation.

## Decision

The Web Host holds a per-session subagent route override beside the session selection. `session.models` reports it as `subagent` (`ModelSelection` or null), and `session.selectSubagentModel` sets or clears it: provider and model arrive together and are validated through `resolveCallConfig`, while both absent clears the override. Like the in-process tier of the session selection, the override is process-local; the image-admission check does not apply because children start their own sessions.

The override reaches delegation through a per-agent holder. The Host mutates the `SubagentModelOverride` that `subagentModelOverrideFor(agent)` returns from `@deepseek-ai/dsh-subagent`'s Agent-keyed registry, and `resolveChildRoute` reads it between the explicit per-request override and the parent's own route, per field. The registry is Agent-keyed because a cordis service registration would land on the root store and serve every agent. A deployment without the entry point keeps parent inheritance. A continuable start's descriptor records the same resolved route, so the route a child actually took stays reconstructable from the child's log. The override carries no reasoning effort because `AgentOptions` has no effort field.

In the browser, the composer seat (`conversation.input.model`) renders a subagent-model trigger left of the session model trigger over the same per-session `ModelDirectory`. Its flat menu offers an inherit row — the default, which clears the override — plus the shared provider-grouped catalog, and submits through the directory's `selectSubagent` verb. Addressed subagent sessions expose neither the seat nor the verb, on the same grounds as the session selection entries.

## Alternatives considered

**Persist the override as a session event or settings value.** An override no delegation has consumed is not model-visible, and the child a delegation starts records the resolved route in its own descriptor and request headers. This mirrors the selector's stance that unused UI intent earns no durable event.

**Extend `session.selectModel` with a target field.** One method would mix two payloads with different pairing and clearing rules; a separate method keeps the nullable-selection semantics and the provider/model pair refinement on its own schema.

**A deployment-wide subagent default in configuration.** A global default redirects every session's children at once. The per-session seat follows the selector's session-over-global rule, and a deployment can still pin routes through composition.

## Consequences

A Web session can point its delegated children at any servable provider/model route once, and a delegation request's explicit route still wins per field. Clearing restores parent inheritance without touching the session selection. The override does not survive a Host restart; a resumed session starts back on parent inheritance until the seat is used again.

## Testing

Host tests pin set/report/clear round-trips, unserved-route rejection, and the holder the delegation seam reads. Subagent unit tests pin the route tiers and the unchanged maxTokens/depth behavior. Client tests pin the directory round-trip through the seat face, the inherit row, the unadvertised-model fallback label, and withholding from addressed subagent sessions.
