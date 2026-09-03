# Agent Note: Coding idle auto-stop — a forgotten timer stops at the last activity

Status: implemented

English | [中文](2026-09-01-coding-idle-auto-stop.zh.md)

## Problem

The [focus gate](2026-09-01-coding-focus-gate.md) made the stopped state guarded, but the running state still depends on the user remembering to press Stop. Walk away from a running timer and it bills the whole absence: totals inflate, and the burnout signal the tracker exists for goes noisy. The ask: after ten minutes with no taps, touch scrolls, or mouse movement, the timer should stop on its own.

## Decision

This note extends the [sidebar coding-time tracker](2026-08-23-coding-time-tracker.md) and the focus gate; store, gate, and calendar decisions are unchanged.

**The auto-stop trims to the last activity, not the fire instant.** When the idle timeout fires, the store's stop runs with the last-activity timestamp, recording the session's end at the last observed input. A timer forgotten over lunch bills nothing past the moment the user actually stopped interacting, and a fire delayed by a sleeping phone or a throttled background tab stays exact by the same trim — the wake path needs no special case. The store's existing end-never-precedes-start clamp already covers the zero-length edge, so the store declaration is untouched.

**The watch is a component-internal hook on the gate cover, armed only while running.** `useIdleAutoStop(running, idleMinutes, stop)` listens for `pointerdown`/`pointermove`/`touchstart`/`touchmove`/`keydown`/`wheel`/`scroll` on window (capture, because scroll does not bubble; passive throughout) with a one-second restamp throttle against pointermove floods. It lives on CodingGate because the `shell.overlay` seat is mounted for the app's whole life regardless of sidebar geometry, and the auto-stop is precisely what returns that cover. While stopped there are zero listeners and zero timers. Keyboard input counts as activity although the request named only taps, scrolls, and mouse movement: coding is mostly typing, and omitting `keydown` would stop the timer mid-session during a typing stretch.

**The timeout is a second Host user-settings field, not a constant.** `idleMinutes` (schema default 10, bounds 1–480 minutes) joins `gate` in the `coding-timer` namespace, riding the gate note's settings-channel rationale (no cordis.yml channel reaches browser plugins; Host storage keeps desktop and phone in agreement). The scope decode defaults each field independently, so sections written before the idle field existed still decode and every stored document keeps working. The stats modal gains an auto-stop row beside the gate toggle, and the settings face resolves free-typed input through `clampIdleMinutes`, so the wire never carries a value the Host schema would reject. The gate face is accordingly renamed `CodingTimerSettingsFace`.

## Alternatives considered

**Stopping at the fire instant (session end = now).** Rejected: the feature exists for the forgotten case, and ending at now silently bills up to the full timeout on every walk-away — exactly the inflation the user wants gone.

**A fixed ten-minute constant.** Rejected per the no-hardcoded-tunables rule: the settings channel built for the gate already carries per-user preferences with GUI reach, and one more field in the same namespace is cheaper than arguing why this timeout, alone among the timer's preferences, should be unchangeable.

**An apply-level watcher beside the store.** Rejected: slot registrations hand the framework the store handle and the framework owns the live instance, so an apply-level watch would have to create its own instance — two instances under one persist key cross-pollute localStorage. Component-internal behavioral effects are also the stack's established home for window listeners (scroll, drag, keydown precedents).

## Consequences

A running timer left alone stops itself and the cover returns showing the trimmed total; the default ten-minute world needs no setup, and persisted histories written before this change are unaffected. Mid-session pauses without input (reading, thinking) are the known false positive, recorded in the package README's Known Limitations alongside the loopback-only preference caveat. Coverage: props-direct jsdom specs pin fire, activity re-arm, throttle, trim-to-last-activity, configured-timeout, and stopped-inert paths; the assembled snapshot lane drives the same arc through the real built bundles with fake timers installed after boot; the wiring spec asserts the idle write rides the scope with clamping. The browser e2e lane gains no case (its composition-boot failure predates this change); the assembled snapshot is the executable pin.
