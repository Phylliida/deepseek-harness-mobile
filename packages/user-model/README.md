# user-model/ — the model-user companion

English | [中文](README.zh.md)

A second selectable model that plays the user role: armed with a goal, it replies when the agent stalls, answers the agent's questions and approval prompts (via the apiproxy's forwarding), and decides itself when the goal is complete. The armed fact is durable on the session log, so restarts, projections, and every consumer read the same state.

| Package | Role | ctx key |
|---|---|---|
| [`user-model/`](user-model/README.md) | Domain: types, events, folds, prompts, parsers, the shared auxiliary call | — |
| [`user-model-driver/`](user-model-driver/README.md) | Stall-driven reply steering with durable disarm | — |
