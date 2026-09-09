# @deepseek-ai/dsh-client-ui-coding-timer

English | [中文](README.zh.md)

Web coding-time tracker: a personal wellbeing surface that measures presence instead of declarations. Every interaction — taps, clicks, pointer drift, typing, scrolling — is a stamp on the shared coding-activity log (`dsh-coding-activity`, one Host-side document `$DSH_HOME/coding-activity.json` behind the `coding.read`/`coding.write` gateway pair), and coding time is the sum of adjacent stamps that sit less than two minutes apart: a lone stamp counts nothing but anchors the next, so bursts on desktop and phone land in one history. Its browser half registers one row into the sidebar-declared `sidebar.timer` seat (between New Session and the workspace browser): an Active/Idle indicator with a ticking `h:mm:ss` readout of the current run plus today's total, and an info button opening a totals calendar. Collapsed to the rail, the row becomes one icon button whose tooltip carries the same readout and whose dot marks the live state; its click opens the same modal — the calendar is reachable from the rail too.

When you leave, the **idle cover** returns: after `idleMinutes` without input in the tab (the layout's `shell.overlay` seat, its one deliberately blocking occupant), the whole UI hides behind a full-frame cover showing today's coded total and the return hint, so coming back to the GUI is a deliberate act rather than an invitation to keep grazing. ANY interaction lifts it — the recorder listens at window capture, so a pointer move over the cover itself restamps and the app underneath (never unmounted) reappears. Idling again covers again. Both preferences live in the Host user-settings document under the `coding-timer` namespace (`gate` and `idleMinutes`, schema defaults `true` and 2 minutes), so every loopback browser pointed at one deployment obeys the same choices; turn the cover off from its "keep the UI always visible" link or from the settings rows at the foot of the stats modal — all write the same fields.

The calendar is a Monday-first month grid: each day cell shows that day's total, each week row ends in its week total, and a summary strip shows today and this week. Stretches crossing midnight split across both days, so late-night coding counts against the day it happened on; the running stretch counts live into today and this week. Every surface — readout, cells, cover — derives from one projection (`displaySpans`: the server's canonical bridge-merged spans plus locally pending stamps, the live tail extended to the render instant), so no two readouts can disagree.

Locally, a controller in `apply` does all the wire work: window input stamps at most once a second, batches flush to `coding.write` after a three-second trailing delay (retry after fifteen on failure, best-effort flush on pagehide), the forwarded `coding-activity/updated` event refreshes the view, and a snapshot (view plus pending stamps) feeds the reactive hook. The retired localStorage history migrates once into the shared log (a running timer counts up to the migration instant), then the key is cleared; a malformed legacy entry is left alone. While the log's first read is in flight or the log is absent, the cover stays down — a cover that might lift is worse than a late cover.

Copy is bilingual: the plugin registers zh/en dictionaries under the `coding-timer` namespace of `dsh-client-locale`, so a locale switch re-renders a mounted row and calendar.

## Model Experience

None, as the tracker is a browser-only wellbeing surface that mounts no tool, contributes no prompt section, and logs no session event, so nothing it holds reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and its zero model-token cost follows from having no model-visible surface.

## Known Limitations and Deferred Work

- **The activity document grows unbounded** — spans accumulate without pruning (about 40 bytes each in the canonical JSON, one per work burst, so years of use fit the storage budget).
- **Presence is input, not attention** — reading or thinking without touching the device for the full `idleMinutes` brings the cover; raise the delay in the stats modal if that bites. A burst left mid-thought costs at most the two minutes between its last two stamps.
- **The preferences are loopback-only** — settings RPCs are loopback-only, so a remote (LAN) browser runs the scope in memory mode: the cover there uses the shipped defaults and the write affordances hide rather than swallow a dead write. The activity log itself is deliberately not loopback-pinned, so the phone records and reads the same history.
- **Offline stamps queue** — a write that fails keeps its batch pending and retries; long-disconnected tabs catch up when the wire heals, but a browser that never reconnects loses its batch at close.
