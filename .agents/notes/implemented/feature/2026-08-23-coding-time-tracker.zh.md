# Agent Note: Sidebar coding-time tracker

Status: implemented

[English](2026-08-23-coding-time-tracker.md) | 中文

## Problem

产品里没有任何信号告诉用户自己一天实际编码了多久。要管理倦怠的人只能在赖以工作的工具之外记录起止时间，而凭记忆重建一天或一周的总量并不可靠。需求是在侧边栏放一个「开始编码 / 停止编码」开关来计时当前时长，并在旁边的信息按钮背后放一个带每日与每周总计的日历。

## Decision

**一个客户端插件包持有该功能。** `@deepseek-ai/dsh-client-ui-coding-timer` 在一个新的侧边栏 seat 注册一行控件：带 `h:mm:ss` 跳字读数的开始/停止编码开关，外加一个打开时长统计日历的信息按钮（周一开头的月网格、每日总计、每周总计列、今天/本周汇总条）。折叠成窄栏时该行渲染为单个图标开关，提示气泡中带有同样的读数。文案在 `coding-timer` 语言命名空间下双语。

**侧边栏声明可追加的 `sidebar.timer` seat。** New Session 与工作区浏览器之间原本没有可组合的位置，而 seat 系统是唯一的组合途径，因此 ui-sidebar 把 `sidebar.timer` 声明为其 `sidebar` 条目的 `list` 类子 slot，并在两种栏状态下渲染（窄栏把它纳入共享的 rail-in 平移动画）。由于两个包之间的 apply 顺序不受约束，占用方通过 `slots.inject()` 注册。取 list 而非 single 让该 seat 无需再改外壳即可容纳后续控件行。

**状态是持久化的客户端 store，从不进入会话日志。** 计时器是个人健康面板：`createCodingTimerStore()` 声明 `{ activeSince, sessions }` 并使用运行时引擎的 localStorage `persist` 通道，进行中的计时与历史在刷新和插件 HMR 后保留。开始/停止在安全方向上幂等，早于开始时间的停止记录零时长会话。没有任何内容进入模型请求，因此不需要新的会话事件，model-visible⟺logged 不变式不受影响。

**日与周总计共享同一个区间重叠原语。** `sumRangeMs()` 把已完成会话与进行中的计时裁剪到任意本地区间，因此按钮读数、日期格、每周列与汇总条不会互相矛盾。跨午夜的会话按天拆分——这个追踪器的意义正是把深夜编码显示在实际发生的那天。日期步进使用 Date 运算而非固定毫秒步长，夏令时切换不会把格子移出午夜。

## Alternatives considered

**把计时器并入 ui-sidebar。** 否决：一个 UI 功能对应一个插件包是既定目录制度，且侧边栏外壳只持有栏几何——健康追踪是独立能力，有自己的 store、日历与词典。

**持久化到服务端（会话日志或 settings 文档）。** 否决：数据属于个人且按浏览器隔离，从不流向宿主或模型；settings 分区会为一份私人活动记录暴露持久偏好面；引擎的 persist 通道已能以零网络面覆盖刷新存活。

**由 `sidebar.workspaces` 的占用方渲染该行。** 否决：浏览区域是 ui-workspace 的 seat，有自己的滚动与窄栏行为，且需求位置在其上方、其几何之外。

## Consequences

该 seat 是可追加的：未来任何控件行都可注册到 `sidebar.timer`，与追踪器并列。历史在 localStorage 中无上限累积（体积很小，已在包 README 记录），且绑定单一浏览器档案——没有跨设备汇总。窄栏只显示开关；日历需要展开的侧边栏。快照覆盖由 ui-sidebar 更新后的外壳快照与本包自身的 props-direct 规格承担；装配后的应用转录不变，因为追踪器不产生模型可见输出。后来加入该包的停止状态专注门禁记录在[其专属笔记](2026-09-01-coding-focus-gate.md)中。
