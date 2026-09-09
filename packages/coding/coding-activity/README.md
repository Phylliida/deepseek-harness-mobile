# @deepseek-ai/dsh-coding-activity

English | [中文](README.zh.md)

Cross-device coding-activity log: the shared memory behind the web GUI's coding-time tracker. Every connected browser (desktop and phone alike) stamps its interactions — taps, clicks, pointer drift, typing, scrolling — into one append-only Host-side record, and the document's canonical form makes concurrent devices commute: interactions enter as millisecond stamps, and maximal runs whose adjacent gaps stay strictly under the two-minute bridge merge into spans. A stamp with no neighbor inside the bridge survives as a zero-length span: it counts no time itself, but anchors a later bridge, so taps at minutes 1, 2, 5, 6, 7, 10, 11 total exactly 1 + 2 + 1 minutes. Span totals are the tracker's whole history — summing a span over a day range is the calendar cell.

The provider (`CodingActivityFileLog`, the default export) persists the log as `coding-activity.json` under the harness home (`path`/`dshHome` config overrides mirror the settings provider). Appends queue in-process, re-read the document inside a cross-process writer lock, and replace it atomically, so two dsh processes never clobber each other, and emit `coding-activity/updated` (the new revision) after each content-changing write. A batch that folds into nothing changes writes nothing, bumps no revision, and emits nothing. Stamps more than ten minutes ahead of the Host clock reject as `CodingActivityRejectedError` — the one semantic check wire-type validation cannot express. The format is versioned (`version: 1`); an unrecognized document fails loud rather than silently zeroing the log.

The Host gateway (`dsh-host-apiproxy`) serves the log to browsers as the `coding.read`/`coding.write` RPC pair and forwards `coding-activity/updated` verbatim, so a stamp posted by the phone updates the desktop's totals within the connection's normal frame flow. The RPC pair is deliberately NOT loopback-pinned: interaction stamps are the LAN client's own incoming data and carry nothing else, and the trusted-host fence already guards the wire.

## Model Experience

None, as the log is the wellbeing tracker's private record: it mounts no tool, contributes no prompt section, and logs no session event, so nothing it holds reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and its zero model-token cost follows from having no model-visible surface.

## Known Limitations and Deferred Work

- **The document grows unbounded** — spans accumulate without pruning (about 40 bytes each in the compact JSON, one per work burst, so years of use fit the storage budget).
- **No external-change watch** — edits or deletions outside the append path are picked up on the next write (appends re-read under the lock), but reads between changes return the last loaded view.
- **Clock skew is trusted within ten minutes** — a stamp inside the future-skew window records at the device's own time; devices with far-worse clocks are rejected, not corrected.
