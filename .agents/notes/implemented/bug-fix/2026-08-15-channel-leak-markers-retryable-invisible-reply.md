# Agent Note: Channel-leak markers turn a gateway-swallowed reply into a retryable error

Status: implemented

English | [中文](2026-08-15-channel-leak-markers-retryable-invisible-reply.zh.md)

## Problem

Some inference gateways do not receive a model's structured thinking/text/tool blocks from upstream. They serve the model's raw channel grammar — Kimi K3's `<|open|>thinking<|sep|>…<|close|>thinking<|sep|><|open|>response<|sep|>…<|open|>tools<|sep|>` markup is the observed instance — and re-parse it into the structured blocks their API (here Anthropic Messages) carries. When that re-parse loses a state boundary, the entire visible reply — response text and tool calls — folds into one `thinking` block and the stream terminates as a silent, reasoning-only `stop`.

A session log captured the failure verbatim: the reasoning block's text ends with the model's own un-emitted transition markup (`…thinking blocks.<|close|>response<|sep|><|open|>tools<|sep|><|open|>call tool="read"…`), followed by `finish: stop` with zero text blocks and zero tool calls. The stream protocol grammar was fully respected — `block-start`/`block-end` pairing, `usage` before `finish` — so the harness had no signal beyond the degenerate shape itself: a completed turn with nothing visible and nothing durable. The adapter deliberately kept a thinking-only `stop` successful ("any block counts as content"), so the session stalled until a human nudged it.

## Decision

Detection is deployment-declared, recovery is the one `EMPTY_RESPONSE` already owns.

- **New provider-neutral code `CHANNEL_LEAK`** (`packages/llm/llm/src/error.ts`): a completed response whose visible reply vanished into the reasoning channel, reported only by an adapter the deployment warned about such markup. It joins the default retryable set in `retry-policy.ts` beside `EMPTY_RESPONSE` — same rationale (nothing durable, safe to repeat), distinct code for diagnosis.
- **New model-entry field `channelLeakMarkers`** in llm-pi-ai (`PiAiModelProfile`, usable from `models` entries and `modelOverrides` values): the markup strings that must never appear in a model's *reasoning* text. Threaded as a per-model map on the resolved profile alongside `configuredMaxTokens` — deployment policy, not pi-ai `Model` fact — and validated (empty marker strings refused at resolution, naming the route and model).
- **Detection at stream finalization** (`mapStopReason`): a `stop` whose content is thinking-only and whose joined reasoning text contains a configured marker maps to the `CHANNEL_LEAK` error finish instead of success. `dsh-llm-retry` then re-issues the step under the route's normal policy (default: up to 2 retries with backoff).

Failure mode mapping, deliberately narrow: markers in reasoning *beside* a visible reply stay a successful stop (everything the model intended arrived; the markup is cosmetic); other stop reasons and the stream-`error` path are untouched.

## Alternatives considered

- **Generic detection without configuration** (e.g. a regex for `<|word|>` shapes on every reasoning-only stop). No configuration step would mean out-of-the-box recovery, but the default would run against providers serving *structured* channels, where markup-looking reasoning is plausible; a falsely retried turn costs a real extra request. Configuration keeps the heuristic opt-in, same as every other per-model dispatch quirk this adapter exposes.
- **Reclassifying every reasoning-only stop as `EMPTY_RESPONSE`.** Removes the narrowness problem entirely but overturns a deliberate, tested decision ("any block counts as content") with nothing new to justify it; the observable failure involves leaked markup, so the marker is what the fix fires on. This is the opt-in refinement of the unconditional rejection in [empty model completions are retryable EMPTY_RESPONSE failures](2026-07-24-empty-model-response-is-retryable.md), which declined reasoning-only reclassification exactly because *unmarked* markup-looking reasoning is legitimate.
- **Client-side closing of the "unterminated" thinking panel.** The GUI renders the block stream faithfully; every chunk the adapter emitted was well-formed. Rendering is not where the reply went missing, and no re-render recovers content that never arrived.
- **Repairing the gateway's channel parse** (synthetic.new, the observed route). The true root boundary — but outside this repo; the adapter fix turns the silent stall into an automatic retry regardless of whether the gateway is ever fixed.

## Consequences

A deployment routing a channel-markup model through a re-parsing gateway adds three lines to its profile (`channelLeakMarkers: ['<|open|>', '<|close|>', '<|sep|>']`) and a swallowed reply retries itself instead of ending the turn on silence. Deployments that configure nothing see no behavior change. The cost borne knowingly: marker strings live in session-visible configuration, the heuristic can back off one good request per false positive (a reasoner that truly thinks in `<|open|>`-shaped prose and then says nothing), and a gateway that collapses replies *reliably* exhausts the retry budget and resurfaces as a plain `CHANNEL_LEAK` turn failure — loud where the old behavior was silent, which is the intent.

## Testing

Unit coverage pairs the decision's three seams: `mapStopReason` classification (tainted thinking-only stop → `CHANNEL_LEAK`; marker-free or text-carrying stops unaffected) and an end-to-end `toStreamChunks` terminal finish; `resolveProfiles` threading and validation (per-model map; empty marker refused with route and model named); and the default retryable-code set gaining `CHANNEL_LEAK`. The full `packages/llm` suite and repo typecheck run green.
