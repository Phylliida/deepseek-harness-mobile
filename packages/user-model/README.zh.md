# user-model/ —— 模型用户伴随

[English](README.md) | 中文

第二个可选模型，扮演用户角色：启用时携带目标，在智能体停滞时作答，回答智能体的问题与审批请求（经 apiproxy 转发），并自行判定目标完成。启用事实持久落在会话日志上，因此重启、投影与每个消费者读取同一状态。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`user-model/`](user-model/README.md) | 域：类型、事件、折叠、提示词、解析器、共享辅助调用 | — |
| [`user-model-driver/`](user-model-driver/README.md) | 停滞驱动的回复驾驭，停用持久 | — |
