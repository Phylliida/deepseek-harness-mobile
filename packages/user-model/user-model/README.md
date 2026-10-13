# @deepseek-ai/dsh-user-model

English | [中文](README.zh.md)

The model-user companion domain: types, durable events, log folds, prompt builders, parsers, and the one shared auxiliary generation call behind the user-model feature — a second selectable model that plays the user role, receives a goal at arming time, replies when the agent stalls, answers its questions and approval prompts, and declares the goal complete itself. [`user-model-driver`](../user-model-driver/README.md) composes the steering loop; the apiproxy's `session.selectUserModel` RPC and its question/approval forwarding consume the same definitions.

## Composition

```yaml
- id: user-model
  name: '@deepseek-ai/dsh-user-model'
```

The plugin registers the `userModel` session projection (the armed selection or null) when a projection registry is composed. It has no configuration and no `ctx` service of its own; arming and disarming are session-log mutations performed by consumers (`session.selectUserModel`, the driver).

## The durable fact

The armed selection — `{ provider, model, prompt }` — lives on the session log as `user-model/armed`, and `user-model/disarmed { reason }` ends it. `readUserModelSelection` folds the pair backwards, so the driver, the apiproxy forwarding seams, the `userModel` projection, and a cold-resumed session all read the same fact without process-local holders. One user-model per session: re-arming replaces the selection by appending a fresh armed event.

Every auxiliary generation passes through `callUserModel`, which appends the exact request as a log-only `user-model/request` event before dispatch — the model-visible boundary is recorded once, in one shape, for driver steering, question answering, and approval verdicts alike. A non-`stop` finish (error, abort, max-tokens, tool calls) or empty text fails the call.

## Replies are not human messages

User-model output enters the session as `user/message` events whose `source.kind` is the declaration-merged `user-model` kind (`{ kind: 'user-model', provider, model }`), never the plain `user` kind — title and skill scanning keep seeing human-typed messages only. The completion sentinel `<task-complete/>` must end a reply; text before it is delivered as closing feedback and the driver disarms with reason `complete`. `parseUserModelQuestions` and `parseUserModelApproval` extract the structured answers the apiproxy forwarding expects.

## Model Experience

### The persona prompt

#### What the model sees

A system prompt casting it as the user in the conversation, carrying the human's goal text, plus a role-flipped transcript (the agent's assistant messages become user-role context and vice versa) so it reads the session from the user's chair. Question and approval asks append a framing message with the exact questions or the pending call and demand a machine-parseable reply. A reply may end with the `<task-complete/>` sentinel to declare the goal complete.

#### Token effect

Each auxiliary call resends the persona and the derived transcript; nothing is retained between calls beyond the session log itself.

#### KV Cache effect

Auxiliary calls go to the armed provider/model route, independent of the session model's cache story.

## Known Limitations and Deferred Work

- **No routing intelligence** — the domain offers folds and builders only; when to reply, when to forward a question, and when to disarm belong to the driver and the apiproxy.
- **One user-model per session** — there is no panel of simulated users; multi-agent chat remains deferred work.
