# Agent Note: Focus gate — the stopped coding timer covers the whole UI

Status: implemented

English | [中文](2026-09-01-coding-focus-gate.zh.md)

## Problem

The coding timer only works if you remember to start it. Left as an opt-in sidebar row, the user forgot to press Start and — the opposite failure — kept working long past a healthy stretch because nothing ever interrupted the flow. The request: make the stopped state the guarded one. When no coding session runs, the whole GUI should hide behind a single Start Coding button; starting the timer restores the normal UI, and stopping re-covers it.

## Decision

This note extends the [sidebar coding-time tracker](2026-08-23-coding-time-tracker.md), whose store, row, and totals decisions are unchanged.

**The gate is a `shell.overlay` occupant, not a shell change.** `ui-coding-timer` registers a second entry, `CodingGate`, into the layout-declared `shell.overlay` list seat — a full-frame opaque cover rendering today's coded total and the Start Coding button. Starting the timer flips the shared persisted store's `activeSince`, which is what lifts the cover; the app underneath never unmounts, so no view state is lost and stopping simply renders the cover again. The seat's click-through contract gains one documented exception: this occupant blocks on purpose (ui-layout's SlotMap JSDoc records it). Both registrations share one store handle — the sanctioned multi-register share — so the row and the gate never disagree.

**The preference lives in the Host user-settings document, not cordis.yml and not localStorage.** The node half registers a `coding-timer` settings namespace whose gate field is a boolean with schema default `true`; the browser half binds it through `ctx.settingsScope` and hands both components the same inject face (`CodingTimerSettingsFace`): the scope itself as the `hooks.gate` source plus the write callbacks. Off-ramps are the cover's "keep the UI always visible" link and a toggle row at the foot of the stats modal. Host-side storage means every loopback browser pointed at one deployment — desktop and phone — obeys the same choice, and the web e2e lane seeds `gate: false` in one scaffold spot (scenarios opt back in with `codingGateOn: true`) instead of seeding per-browser storage in every spec.

**Two deliberate state asymmetries.** While the first settings read is in flight the gate renders nothing — a cover that might lift is worse than a late cover, and a disabled gate must never flash. And when the scope runs in memory mode (non-loopback browser; settings RPCs are loopback-only), the gate holds its default-on state but the disable affordances hide, because a write that silently discards would read as broken.

## Alternatives considered
**A cordis.yml plugin config (`gate: true`).** Rejected: client plugin entries are created from the boot manifest with no per-row config channel, so the value could not reach the browser half without new wire surface in three packages (host graph scan, manifest parse, boot kernel). The user-settings channel already exists, is writable from the GUI itself, and is where theme/locale preferences already live.

**A flag in the timer's localStorage store.** Rejected as the primary home: the engine's persistence is whole-value replace, so a new field reads `undefined` for every pre-gate persisted state (needing an "absent means on" carve-out), per-browser storage forks the preference across the user's devices, and the e2e lane would have had to seed localStorage in every scenario file rather than mutating one Host document. localStorage remains right for the history itself, which is per-browser by nature.

**Hiding the UI by unmounting it (conditional render at the root).** Rejected: an overlay keeps every column mounted, so lifting the gate is instant and nothing (drafts, scroll, panel geometry) is destroyed by taking a break.

## Consequences

The gate ships on: a fresh profile opens to the cover, which is the point and also the visible behavior change any existing user notices first. The web e2e lane's default world disables it, so goldens are untouched; `coding-gate.e2e.ts` covers the on-path (cover → start → running row → stop → cover) and the disable persistence across reload. The timer package's node half is no longer empty (namespace registration), and the package picks up `dsh-settings`/`schemastery` dependencies plus ui-layout/ui-settings type edges. LAN browsers get the gate without an off-ramp — consistent with how every Host-backed preference behaves there, and recorded in the package README's Known Limitations. The idle auto-stop that guards the running state is recorded in [its own note](2026-09-01-coding-idle-auto-stop.md).
