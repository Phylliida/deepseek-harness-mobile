# Agent Note: Sidebar coding-time tracker

Status: implemented

English | [中文](2026-08-23-coding-time-tracker.zh.md)

## Problem

There is no signal in the product for how much coding the user actually does in a day. Someone managing burnout has to track start and stop times outside the tool they live in, and reconstructing a day or week total from memory does not work. The ask was a Start Coding / Stop Coding toggle in the sidebar that times the running stretch, and a calendar with daily and weekly totals behind an info button next to it.

## Decision

**One client plugin package owns the feature.** `@deepseek-ai/dsh-client-ui-coding-timer` registers one row into a new sidebar seat: a Start/Stop Coding toggle with a ticking `h:mm:ss` readout plus an info button opening a totals calendar (a Monday-first month grid, per-day totals, a week-total column, and a today/this-week summary). Collapsed to the rail, the row renders as one icon toggle whose tooltip carries the readout. Copy is bilingual under the `coding-timer` locale namespace.

**The sidebar declares an additive `sidebar.timer` seat.** Placement between New Session and the workspace browser has no existing hole, and the seat system is the only composition route, so ui-sidebar declares `sidebar.timer` as a `list`-kind child of its `sidebar` entry and renders it in both column states (the rail includes it in the shared rail-in translation). The occupant registers through `slots.inject()` because apply order between the packages is unconstrained. A list kind, not single, keeps the seat open to further control rows without another shell change.

**State is a persisted client store, never the session log.** The timer is a personal wellbeing surface: `createCodingTimerStore()` declares `{ activeSince, sessions }` with the runtime engine's localStorage `persist` channel, so a running timer and the history survive reloads and plugin HMR. Start/stop are idempotent in the safe direction, and a stop earlier than its start records a zero-length session. Nothing reaches a model request, so no session event is required and the model-visible⟺logged invariant is untouched.

**Day and week totals share one overlap primitive.** `sumRangeMs()` clips completed sessions and the live stretch to any local range, so the button readout, day cells, week column, and summary strip cannot disagree. Sessions crossing midnight split across both days — the tracker's point is showing late-night coding on the day it happened. Day stepping uses Date arithmetic rather than fixed millisecond strides so DST never shifts a cell off midnight.

## Alternatives considered

**Fold the timer into ui-sidebar.** Rejected: one UI feature per plugin package is the directory regime, and the sidebar shell owns column geometry only — a wellbeing tracker is a separate capability with its own store, calendar, and dictionaries.

**Persist server-side (session log or a settings document).** Rejected: the data is per-person and per-browser, never crosses to the host or a model, and a settings section would expose a durable preferences surface for what is a private activity record; the engine's persist channel already covers reload survival with zero wire surface.

**Render the row from the `sidebar.workspaces` occupant.** Rejected: the browser region is ui-workspace's seat with its own scroll and rail behavior, and the requested placement sits above it, outside its geometry.

## Consequences

The seat is additive: any future control row registers into `sidebar.timer` beside the tracker. History accumulates unbounded in localStorage (small; documented in the package README) and is tied to one browser profile — no cross-device rollup. The rail shows only the toggle; the calendar requires the wide sidebar. Snapshot coverage lives in ui-sidebar's updated shell snapshots and the package's own props-direct specs; the assembled-app transcript is unchanged because the tracker emits no model-visible output.
