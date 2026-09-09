# coding/ — cross-device coding-activity log

English | [中文](README.zh.md)

The shared, append-only record behind the web GUI's coding-time tracker: every connected browser stamps its interactions here, and the canonical bridged spans (see the package README) are the one cross-device history the tracker totals. The log is personal wellbeing state, deliberately outside the session log; no model-facing surface reads it.

| Package | Role | ctx key |
|---|---|---|
| [`coding-activity/`](coding-activity/README.md) | Activity document format, merge math, and file-backed provider | `ctx.codingActivity` |
