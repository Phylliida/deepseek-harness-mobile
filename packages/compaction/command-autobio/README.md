# @deepseek-ai/dsh-command-autobio

English | [中文](README.zh.md)

Human-facing `/autobio` control over the [autobiographical compaction backend](../compaction-autobiographical/README.md). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter can report and switch the backend's automatic folding without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/autobio`, `/autobio status` | Report whether automatic folding is on, and what the current state means for the session. |
| `/autobio on` | Register the step-boundary folding pass; report the state it left behind. |
| `/autobio off` | Remove the step-boundary folding pass; report the state it left behind. |
| `/autobio <anything else>` | `Usage: /autobio [on|off|status]` — no state change. |

Arguments are trimmed and case-folded, so `/autobio OFF` and `/autobio  status ` are accepted. Every resolved invocation records the executor-owned log-only pair `command/run` / `command/done`; neither event joins model history.

The command is backend-specific: it drives `AutobiographicalCompactionEngine` and reports an error when the mounted `ctx.compaction` provider is another backend, rather than appearing to toggle something it does not own. Turning folding off removes the engine's step-boundary listener, so the surface stops changing between turns and no memory-formation call starts. Explicit folding is untouched — `/compact`, and any other caller of `compactNow()` or `compactIfNeeded()`, still folds while automatic folding is off, and a pass already in flight when the command lands still finishes its folds, including a memory-formation call already running.

The toggle is runtime state, not configuration: a restart returns the engine to the `auto` value in its own config.

## Composition

Mount the backend and this plugin beside the command registry:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-autobiographical
  name: '@deepseek-ai/dsh-compaction-autobiographical'
- id: command-autobio
  name: '@deepseek-ai/dsh-command-autobio'
```

The shipped `dsh` base mounts `/compact` and `compaction-basic`; a profile that opts into autobiographical folding adds this backend row and, to control it from the conversation, this command beside it.

## Model Experience

### Human `/autobio` control

#### What the model sees

Neither the slash input nor the direct result enters a model request: the command is dispatched by `ctx.commands` and answered outside the conversation. Turning folding off does change what later requests contain — already-folded regions keep the recollection they were replaced with and stop coarsening further — but the toggle itself adds and removes no model-visible text.

#### Token effect

The command adds no model tokens. The state it selects does: automatic folding removes each shadowed span's tokens from later requests and spends one memory-formation request per compressed chunk, so switching it off freezes the surface's token cost until an explicit request folds again.

#### KV Cache effect

Command discovery and bookkeeping do not affect the cache. While folding stays off, no fold lands and later requests keep reusing the warm prefix; switching it back on invalidates reuse from the first shadowed node of the next pass, exactly as the backend's own folding does.

## Known Limitations and Deferred Work

- **One backend** — the command narrows `ctx.compaction` to the autobiographical engine and refuses any other provider, so a deployment running `compaction-basic` gets an error instead of a silent no-op. A generic engine-control seam does not exist.
- **Context-wide, not per session** — the engine is one service per context, so the toggle covers every session that engine serves rather than only the invoking one.
- **State is not persisted** — the toggle lives in the loaded engine instance; nothing in the session log records that folding was switched off, so an operator reading the log later sees folds that stopped without a recorded reason.
- **No schedule control** — the command switches folding on or off; it cannot ask for one pass on demand (that is `/compact`) or retune windows and thresholds at runtime, which remain config-only.
