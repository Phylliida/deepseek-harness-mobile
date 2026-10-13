# Agent Note: User-model companion

Status: implemented

English | [中文](2026-10-11-user-model-companion.zh.md)

## Problem

Working with a coding agent over the GUI means a human must be present for three recurring interactions: replying when the agent stalls at idle, answering its structured questions, and settling its tool-approval asks. Long-running objectives therefore cannot run unattended, and there is no way to rehearse or automate the user's side of the conversation. The goal-round driver already solved stall-continuation for goals, but it drives the *agent* with canned prompts; nothing played the *user* — deciding what to say from the transcript, answering questions as asked, judging approvals, and stopping when the objective is met.

The design question is where the authority for that second participant lives. A process-local holder would lose the armed state on restart and could diverge between the driver, the interaction seams, and the GUI. A second durable session or a forked conversation would break the single-transcript mental model this feature is a stepping stone toward (multi-agent chats).

## Decision

A model-user companion: a second selectable model, armed per session with a human-written goal prompt, that plays the user role in the same session. Three layers ship it:

- **Domain — `@deepseek-ai/dsh-user-model`.** The armed fact is a durable session-event pair: `user-model/armed { provider, model, prompt }` and `user-model/disarmed { reason }`, folded backwards by `readUserModelSelection`. Every consumer — driver, apiproxy forwarding, the `userModel` session projection, cold resume — reads the log alone; there is no process-local authority to diverge. Every auxiliary generation passes through `callUserModel`, which appends the exact request as a log-only `user-model/request` event before dispatch (model-visible ⟺ logged, mirroring session-title-llm's pre-dispatch record). The package also owns the persona system prompt, the role-flipped transcript builder, and the question/approval prompt renderers and parsers.
- **Driver — `@deepseek-ai/dsh-user-model-driver`.** Wakes on `agent/status` idle, job-set changes, and `user-model/armed`; drives only when the fiber is ACTIVE, the exact `Agent` lifecycle is registered, the agent is idle with an empty inbox, and no owned job runs. Readiness is re-checked after each awaited generation, so human input arriving mid-flight makes the reply stale rather than interrupted. `maxReplies` (default 20) caps replies per arming; `maxTokens` (default 4096) caps each generation. Disarm reasons: `user`, `complete` (the `<task-complete/>` sentinel, which must end the reply; preceding text is delivered as closing feedback), `turn-failed`, `generation-failed`, `replies-exhausted`. A disarm append that itself fails fails closed: no further replies, and the failure is logged. `Session.append` rejects reentrancy during event publish, so armed-event wakeups schedule on a microtask and a disarm observed mid-schedule is recorded and committed by that run.
- **Interaction seams — apiproxy.** `session.selectUserModel` validates the route through `ctx.llm.resolveCallConfig` and appends the armed/disarmed events. While armed, the question provider and the approval listener consult the user-model first: questions are answered from the parsed selection list, approvals from the parsed `{"approved": ...}` verdict rendered with the exact call arguments. Any auxiliary failure falls back to the human mux path unchanged, so an armed user-model can never strand a question or approval. `userModelMaxTokens` (default 4096) bounds these calls.

User-model replies enter the session as `user/message` events whose source is the declaration-merged `user-model` kind (`{ kind: 'user-model', provider, model }`), never the plain `user` kind: title generation and skill scanning keep seeing human-typed messages only, and the reply cap counts only model-sourced replies under the current arming.

The GUI gains a third trigger in the model seat (`packages/client/ui-model-selection`): a goal editor whose non-empty text enables the catalog rows, an armed summary with a disarm row while armed. The seat echoes the `userModel` projection rather than directory state, so a disarm committed by the driver or another client is what the seat shows next.

## Alternatives considered

- **Process-local armed holder (registry keyed by session id).** Rejected: restart and cold resume would silently drop the armed state, and the driver, seams, and projection would each need their own view of a mutable in-memory fact. The durable event pair makes replay the single authority at no extra machinery — the fold is a backward scan.
- **Masquerading replies as `source: { kind: 'user' }`.** Rejected: title generation and skill scanning treat `user` messages as human-typed; model-authored replies would leak into human-only heuristics. The dedicated source kind keeps every human-only consumer correct by construction while the message still reads as user-role to the agent.
- **A second session or forked transcript for the user-model's view.** Rejected: the feature is a stepping stone toward multi-agent chats inside one transcript; a parallel session would duplicate history, double durable storage, and invent a sync protocol for what the role-flipped transcript builder derives in one pass.
- **Extending `GenerateOptions.purpose` with a `user-model` variant.** Rejected as unnecessary: the purpose is recorded on the log-only `user-model/request` event, which carries more context (system prompt, messages, route) than a purpose tag on the LLM stream would expose, and the closed purpose union stays untouched.
- **A pre-step reservation fence like the goal-round driver's.** Rejected: the goal driver needs CAS reservation because `roundsStarted` is a durable counter that must advance exactly once per round. The user-model driver has no durable counter to protect — its cap fold tolerates an occasional dropped reply, and the post-generation readiness re-check already prevents stale sends.

## Consequences

An unattended session can run to a model-judged completion: the agent's stalls, questions, and approval asks are answered by the armed model, and the human reads the transcript afterward with every auxiliary call logged verbatim on the session. The `userModel` projection gives the GUI (and any future client) the armed state without a wire-protocol change.

The costs: an armed session burns tokens on two models; the reply cap is a reply count, not a resource budget, so a runaway loop is bounded only by `maxReplies` (20 per arming); completion judgment is the user-model's own, with no independent evaluator; and question/approval quality is entirely the armed model's — a weak route answers weakly, and the human only sees the outcome in the log. One user-model per session; the multi-agent panel this is a stepping stone toward remains deferred.
