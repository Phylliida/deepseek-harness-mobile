# @deepseek-ai/dsh-client-ui-coding-timer

English | [中文](README.zh.md)

Web coding-time tracker: a personal wellbeing surface for pacing how much coding you do. Its browser half registers one row into the sidebar-declared `sidebar.timer` seat (between New Session and the workspace browser): a Start Coding / Stop Coding toggle that times the running stretch with a ticking `h:mm:ss` readout, plus an info button opening a totals calendar. Collapsed to the rail, the row becomes one icon toggle whose tooltip carries the same readout, and a dot marks the running state.

The calendar is a Monday-first month grid: each day cell shows that day's total, each week row ends in its week total, and a summary strip shows today and this week. Sessions crossing midnight split across both days, so late-night coding counts against the day it happened on; the running stretch counts live into today and this week. Month navigation moves the grid without losing history.

State is a `defineStore` declaration with the runtime engine's `persist` channel, so the running timer and the completed-session history survive page reloads and plugin HMR through localStorage. Start/stop are idempotent in the safe direction — starting a running timer or stopping a stopped one is a no-op — and a stop pressed before its start records a zero-length session rather than a negative one. The store is the only copy of the data: the timer never enters the session log, and no model-facing tool reads it.

Copy is bilingual: the plugin registers zh/en dictionaries under the `coding-timer` namespace of `dsh-client-locale`, so a locale switch re-renders a mounted row and calendar.

## Model Experience

None, as the tracker is a browser-only wellbeing surface that mounts no tool, contributes no prompt section, and logs no session event, so nothing it holds reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request, and its zero model-token cost follows from having no model-visible surface.

## Known Limitations and Deferred Work

- **History is per-browser** — localStorage persistence ties totals to one browser profile on one machine; there is no cross-device rollup.
- **History grows unbounded** — completed sessions accumulate without pruning (about 50 bytes each, so years of use fit the storage budget).
- **The rail hides the calendar** — collapsed, only the toggle is reachable; open the sidebar to reach the info button.
