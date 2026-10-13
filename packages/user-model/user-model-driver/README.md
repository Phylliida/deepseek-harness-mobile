# @deepseek-ai/dsh-user-model-driver

English | [中文](README.zh.md)

The steering driver for the [user-model companion](../user-model/README.md): while a user-model is armed on a session, it replies in the user's place whenever the exact live agent stalls, until the model declares the goal complete, a reply cap is reached, or something fails — at which point it disarms durably and the human takes over.

## Composition

```yaml
- id: user-model
  name: '@deepseek-ai/dsh-user-model'

- id: user-model-driver
  name: '@deepseek-ai/dsh-user-model-driver'
```

`maxReplies` (default 20) caps user-model replies per arming; `maxTokens` (default 4096) caps each generation. Both must be positive integers and are validated at apply time.

## Drive contract

The driver considers an agent drivable only when the fiber is ACTIVE, the exact `Agent` lifecycle is still the registered one, the agent is `idle` with an empty inbox, no owned job is running or stopping, and the log folds to an armed selection. It wakes on `agent/status` reaching idle, on job-set changes, and on `user-model/armed` events — the latter scheduled on a microtask because `Session.append` rejects reentrancy during event publish. Human input arriving before or during a generation makes the in-flight reply stale: the driver re-checks readiness after the awaited call and drops the reply instead of interrupting.

A reply is one `callUserModel` generation whose system prompt is the persona and whose messages are the role-flipped transcript; the resulting text enters the session as a `user/message` carrying the `user-model` source. A reply ending in `<task-complete/>` disarms with reason `complete` after delivering the preceding text. Question and approval asks are not the driver's business — the apiproxy forwarding answers those inline.

## Disarm is durable

Every exit from the armed state appends `user-model/disarmed`: `user` (explicit disarm or re-arm, via the RPC), `complete` (the sentinel), `turn-failed` (the agent's last turn aborted or errored), `generation-failed` (adapter failure, unparseable output, or a follow-up send that could not commit), `replies-exhausted` (the per-arming cap). A disarm requested while a drive is scheduled or in flight is recorded and committed by that same run. If the disarm append itself fails, the driver fails closed — no further replies — and logs the failure.

## Lifecycle and durability

Plugin teardown marks each live state stopping, aborts any in-flight generation, and awaits the run plus agent quiescence; a durability failure during teardown leaves no rescheduled work behind. Loading over an already-armed session is safe: the armed fold is replay-derived, so the driver simply starts honoring it at the next idle checkpoint.

## Model Experience

### The steering reply

#### What the model sees

The domain's persona prompt and role-flipped transcript, exactly as [`dsh-user-model`'s Model Experience](../user-model/README.md#model-experience) describes; the driver adds no prompt content of its own.

#### Token effect

One auxiliary generation per stall, bounded by `maxTokens` (default 4096); the per-arming reply count is bounded by `maxReplies` (default 20).

#### KV Cache effect

Each reply extends the session log with one user-role message, so the agent's next request grows by that reply; the auxiliary calls themselves ride the armed route's own cache story.

## Known Limitations and Deferred Work

- **Reply cap, not resource budget** — token, currency, and time policies remain independent; the driver counts replies only.
- **No abnormal auto-retry** — generation failures disarm rather than retry; re-arming is the human's call.
- **One stalled-agent responder** — the driver only answers stalls; it does not preempt queued human input or steer mid-turn.
