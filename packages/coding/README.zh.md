# coding/ — 跨设备编码活动日志

[English](README.md) | 中文

Web GUI 编码时长追踪器背后的共享追加记录：每个已连接的浏览器都把交互打点写入这里，规范合并后的桥接区间（见包 README）就是追踪器汇总时长的唯一跨设备历史。该日志属于个人节奏数据，刻意不进入会话日志；任何面向模型的表面都不读取它。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`coding-activity/`](coding-activity/README.md) | 活动文档格式、合并规则与文件持久化 provider | `ctx.codingActivity` |
