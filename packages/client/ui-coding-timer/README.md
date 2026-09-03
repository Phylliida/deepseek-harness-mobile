# @deepseek-ai/dsh-client-ui-coding-timer

English | [中文](README.zh.md)

Web coding-time tracker: a personal wellbeing surface for pacing how much coding you do. Its browser half registers one row into the sidebar-declared `sidebar.timer` seat (between New Session and the workspace browser): a Start Coding / Stop Coding toggle that times the running stretch with a ticking `h:mm:ss` readout, plus an info button opening a totals calendar. Collapsed to the rail, the row becomes one icon toggle whose tooltip carries the same readout, and a dot marks the running state.

While no session runs, the **focus gate** covers the whole UI: a full-frame overlay (the layout's `shell.overlay` seat, its one deliberately blocking occupant) showing today's coded total and a single Start Coding button, so opening the GUI is a deliberate act rather than an invitation to keep grazing. Starting the timer lifts the cover — the app underneath stayed mounted, so nothing loses state — and stopping brings it back. A running timer also guards itself: after `idleMinutes` without input activity (taps, typing, pointer drift, scrolling), it stops on its own, recording the session as ending at the last activity rather than at the fire instant, so a forgotten timer never bills its idle tail and the returning cover is the re-entry prompt. Both preferences live in the Host user-settings document under the `coding-timer` namespace (`gate` and `idleMinutes`, schema defaults `true` and 10 minutes), so every loopback browser pointed at one deployment obeys the same choices. Turn the gate off from the cover's "keep the UI always visible" link or from the settings rows at the foot of the stats modal; all write the same fields.

The calendar is a Monday-first month grid: each day cell shows that day's total, each week row ends in its week total, and a summary strip shows today and this week. Sessions crossing midnight split across both days, so late-night coding counts against the day it happened on; the running stretch counts live into today and this week. Month navigation moves the grid without losing history.

State is a `defineStore` declaration with the runtime engine's `persist` channel, so the running timer and the completed-session history survive page reloads and plugin HMR through localStorage. Start/stop are idempotent in the safe direction — starting a running timer or stopping a stopped one is a no-op — and a stop pressed before its start records a zero-length session rather than a negative one. The store is the only copy of the history: the timer never enters the session log, and no model-facing tool reads it. The preference pair is separate Host-side state (the node half registers the namespace schema when a settings provider is composed); while the first settings read is in flight the gate shows nothing, so a disabled gate never flashes the cover.

Copy is bilingual: the plugin registers zh/en dictionaries under the `coding-timer` namespace of `dsh-client-locale`, so a locale switch re-renders a mounted row and calendar.

## Model Experience

None, as the tracker is a browser-only wellbeing surface that mounts no tool, contributes no prompt section, and logs no session event, so nothing it holds reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and its zero model-token cost follows from having no model-visible surface.

## Known Limitations and Deferred Work

- **History is per-browser** — localStorage persistence ties totals to one browser profile on one machine; there is no cross-device rollup.
- **History grows unbounded** — completed sessions accumulate without pruning (about 50 bytes each, so years of use fit the storage budget).
- **The rail hides the calendar** — collapsed, only the toggle is reachable; open the sidebar to reach the info button.
- **The idle watch only sees input** — reading or thinking without touching the device for the full `idleMinutes` timeout stops the timer mid-session; raise the timeout in the stats modal if that bites.
- **The preferences are loopback-only** — settings RPCs are loopback-only, so a remote (LAN) browser runs the scope in memory mode: the gate stays at its default-on state there and the write affordances hide rather than swallow a dead write.
