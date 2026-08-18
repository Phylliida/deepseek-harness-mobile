# Agent Note: `allowUnobservedMutation` config for the fs observation policy

Status: implemented

English | [中文](2026-08-15-fs-policy-unobserved-mutation-config.zh.md)

## Problem

[The file-context-as-event-gate Agent Note](../architecture/2026-06-26-file-context-as-event-gate.md) makes `dsh-fs-observation-policy` an optional plugin: drop it and the fs tools run unconditional (no read-before-write/edit), load it and every write or edit of an unobserved existing file fails `FS_NOT_OBSERVED`. Some deployments want a stance between those poles — an agent that frequently receives file content through other channels (grep results, diffs, task descriptions) pays a mandatory `read` round-trip and token cost for files it already knows, while the all-or-nothing plugin removal also gives up the version CAS guard that catches out-of-band changes on files it *did* read. The only escape hatch was dropping the whole policy.

## Decision

`dsh-fs-observation-policy` gains a schemastery-validated `Config` with one field:

```ts ignore-check
interface Config {
  allowUnobservedMutation?: boolean  // default false
}
```

`false` (the default; the shipped bundles keep it) preserves the documented decisions exactly. `true` relaxes only the **unseen**-target decisions in the two intent listeners:

- `fs/write-intent`: unseen ⇒ `undefined` (fall through to the bare provider's unconditional write) instead of `createIfAbsent`, so overwriting an existing unobserved file no longer fails `FS_NOT_OBSERVED`.
- `fs/edit-intent`: unseen ⇒ `undefined` (unconditional provider edit) instead of throwing `FS_NOT_OBSERVED`.

Confirmed observations still decide in both modes: observed-present keeps its CAS guard (`replaceIfVersion` / `{ version }`, so an external change since the observation still fails `FS_STALE_VERSION`), and observed-absent keeps `createIfAbsent` / `FS_NOT_FOUND`. The owner derivation, the `fs/observed` recording contract, and the single-slot first-wins convention are unchanged, matching the event-gate Note's mechanism. The model-facing tool prompt text is unchanged: it already hedges the read-first guidance on "the default fs-observation-policy".

## Alternatives considered

- **Drop the plugin in the deployment's cordis.yml** — the previously documented escape hatch; loses the CAS guard wholesale, so reads no longer buy any stale-change protection, and a single deployment-wide switch could not keep `FS_STALE_VERSION` for files the agent did read.
- **Two flags (`allowUnobservedWrite` / `allowUnobservedEdit`)** — finer-grained but unjustified: no consumer asked to relax one mutation without the other, and [`dsh-find-simplifications`](../../../skills/dsh-find-simplifications/SKILL.md) policy disfavors speculative option sets; split only when a real deployment needs the asymmetry.
- **Relax observed-absent decisions too** (unconditional edit of a target recorded absent) — rejected: absence is a confirmed observation, and the incoherence the `FS_NOT_OBSERVED`-era guard catches there (editing a file the agent believes is missing) is a model error worth surfacing, not a token-saving case.

## Consequences

- **Lax mode weakens the blind-overwrite deterrent exactly where configured.** An unseen overwrite cannot report the stale content it destroys; the deployment opt-in makes that acceptable for agents fed file content out of band. Files the agent has read remain CAS-protected, which is the middle-stance value proposition dropping the plugin could not offer.
- **The shipped default and every existing snapshot/transcript are unchanged.** Lax behavior is reachable only through explicit cordis.yml config, keeping opt-ins out of shipped defaults.
- **Non-tool coverage is unchanged and incomplete either way.** Reads outside the `read` tool (`ctx.fs.readText`, shell `cat`, grep output) still record no observation; lax mode makes that gap harmless for mutation authority rather than closing it.

## Testing

Unit tests in `dsh-fs-observation-policy` pin the six decision outcomes under `allowUnobservedMutation: true` (unseen write/edit fall through, observed-present CAS intact, observed-absent unchanged) and the strict default remains pinned by the existing suite; `dsh-tool-fs` integration tests exercise the lax deployment end-to-end against the real local backend: unobserved overwrite/edit succeed, an observed file's stale write still fails `FS_STALE_VERSION`, and editing a target observed absent still fails `FS_NOT_FOUND`.
