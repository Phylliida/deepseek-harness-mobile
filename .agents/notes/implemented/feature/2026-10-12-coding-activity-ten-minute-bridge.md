# Agent Note: Coding activity bridges gaps under ten minutes

Status: implemented

English | [中文](2026-10-12-coding-activity-ten-minute-bridge.zh.md)

## Problem

The [shared coding-activity log](2026-09-06-coding-activity-shared-log.md) joined adjacent interactions only when they sat less than two minutes apart. Reading, thinking, and sparse phone taps routinely leave longer pauses, so real work recorded as isolated zero-length stamps: stamps at 2:34, 2:43, 2:52, 3:22, 3:25, and 3:29 totaled nothing. The intended rule unions any gap under ten minutes and splits on longer gaps, so the same stamps total 18 + 7 minutes. The same report surfaced two browser defects that made the tracker look stuck: the sidebar row stayed Idle after any idle stretch, and the idle cover returned late after a long cover.

## Decision

**`CODING_ACTIVITY_BRIDGE_MS` is 600 000 ms.** The bridge stays a fixed format constant shared by the Host fold and the browser projection; the comparison stays strict, so a gap of exactly ten minutes splits. No migration exists or is needed: spans canonicalized under the two-minute bridge re-merge on the next fold exactly as their raw stamps would under ten minutes, because every gap inside a stored span is already under the wider bridge and every gap between stored spans is a real stamp-to-stamp gap. Until that next write, the browser's `displaySpans` re-merges whatever the Host serves, so totals are correct on first read.

**Idle surfaces re-read the clock when activity changes.** The sidebar row ticks only while live, so its `now` held the last tick; a new tail stamped after that instant could never satisfy `now >= tail.end`, and the row stayed Idle with a frozen day boundary. The row now refreshes `now` on every activity snapshot while idle. The idle cover armed its timeout as `boundary - now`, where `now` held the last fire, so after a long cover the next cover arrived late by the cover's length; it now measures from `Date.now()`.

## Alternatives considered

**A configurable bridge.** Rejected for the reason the shared-log note gives: devices holding different tolerances would fold the same history differently. Widening a constant is lossless; narrowing cannot split stored spans, so a per-device setting would make history depend on write order.

**Raise the idle cover delay to ten minutes as well.** Not done: the cover is a separate, user-tunable preference that only affects this tab's chrome. The cover can now appear while the run is still live, and its total includes the provisional tail up to the render instant.

**Tick the sidebar clock once a second at all times.** Rejected: a steady re-render on every idle tab buys nothing that a refresh on activity change does not, since an idle row's readout changes only when a snapshot does.

## Consequences

Pauses under ten minutes count as coding time, and existing logs widen in place on the next write. The live tail now extends up to ten minutes past the last input, so the Active readout and today's total keep counting during a pause and drop back if the pause reaches ten minutes. An idle tab left open across midnight keeps the previous day's total until the next interaction or remote write. Coverage: `document.spec.ts` pins the 18 + 7 example and the strict boundary, the row and cover specs pin resume after a long idle stretch, and the assembled `coding-gate.snapshot.ts` holds the cover for an hour before the lift and re-cover; that snapshot now installs fake timers before the interaction and waits on the timer's own stats button.
