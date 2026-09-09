# @deepseek-ai/dsh-coding-activity

[English](README.md) | 中文

跨设备编码活动日志：Web GUI 编码时长追踪器的共享记忆。每个已连接的浏览器(桌面与手机)都把交互——点击、指针移动、输入、滚动——以毫秒打点追加到同一份 Host 侧记录;文档的规范形式让并发设备的写入可交换:相邻间隔严格小于两分钟桥接窗口的最长打点串合并为区间,没有邻点落入桥接窗口的打点以零长区间留存——它本身不计时,但充当后续桥接的锚点,因此第 1、2、5、6、7、10、11 分钟的点击恰好合计 1 + 2 + 1 分钟。区间就是追踪器的全部历史:把区间按天切片求和即日历格。

Provider(`CodingActivityFileLog`,默认导出)把日志持久化为 harness home 下的 `coding-activity.json`(`path`/`dshHome` 配置项与 settings provider 一致)。追加在进程内排队、在跨进程写锁内重读文档、并以原子替换落盘,两个 dsh 进程不会互相覆盖;每次改变内容的写入之后发出 `coding-activity/updated`(新修订号)。折叠后无变化的批次不写入、不增修订、不发事件。领先 Host 时钟超过十分钟的打点以 `CodingActivityRejectedError` 拒绝——这是线类型校验表达不了的唯一语义检查。格式带版本号(`version: 1`);无法识别的文档直接报错,不会静默清空日志。

Host 网关(`dsh-host-apiproxy`)以 `coding.read`/`coding.write` RPC 对向浏览器提供该日志,并原样转发 `coding-activity/updated`,手机提交的打点在连接的正常帧流内即可刷新桌面的总计。这对 RPC 刻意不做仅回环(pin)限制:交互打点是 LAN 客户端自己的输入数据,不携带其他内容,trusted-host 防线已经守住通道。

## Model Experience

无:该日志是时长追踪器的私有记录,不挂载工具、不贡献提示词段落、不产生会话事件,其中任何内容都不会进入模型请求。

#### KV Cache effect

无:本包既不组装也不发送 provider 请求;它没有任何对模型可见的表面,模型 token 成本因此为零。

## Known Limitations and Deferred Work

- **文档无界增长** —— 区间只增不剪(紧凑 JSON 下每条约 40 字节,一次工作突发一条,数年的使用也在存储预算内)。
- **不监听外部修改** —— 追加路径之外的编辑或删除会在下一次写入时被感知(追加在锁内重读),但两次修改之间的读取返回上次加载的视图。
- **十分钟内的时钟偏移被信任** —— 未来偏移窗口内的打点按设备自身时间入库;时钟偏差更大的设备被拒绝,而不是被纠正。
