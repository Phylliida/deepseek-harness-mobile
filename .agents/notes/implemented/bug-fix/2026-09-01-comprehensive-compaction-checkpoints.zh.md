# Agent Note: 压缩指令以全面细节优先于简洁

Status: implemented

[English](2026-09-01-comprehensive-compaction-checkpoints.md) | 中文

## 问题

`COMPACTION_INSTRUCTION` 要求摘要器把对话「浓缩」成「简洁工程散文」中的「简短项目符号」，这些措辞中的每一个都以覆盖率为代价换取篇幅：调查过程、中间步骤、错误尝试、学到的事实与假设经常被摘要省略掉。段落模板中没有按时间顺序记录行动的位置，也没有存放「疑似但未验证」解释的位置，因此即使完全符合指令的摘要也无法保留这些内容。由于检查点在后续周期中会被合并，第一次摘要丢弃的内容就永久丢失了。

## 决策

指令声明的优先级被反转：全面性优先于简洁性。它以 "Completeness is the priority: it is far better to include a detail than to drop it" 开头；`## Work Log` 段落要求按时间顺序记录所做的每一件事——调查、阅读或探索了什么，运行了哪些命令，修改了哪些文件（带确切路径），执行了哪些检查及其结果——并给出每个行动的原因。`## Things Learned` 收集发现的事实与被纠正的假设；`## Footguns and Pitfalls` 保留反复出现的陷阱——项目或环境特有的怪癖、会出错或产生误导的命令与方法、不稳定步骤及其变通办法、容易违反的约定——使它们在压缩之后不被重蹈；`## Decisions and Rationale` 记录谁在何时做了什么决定及其理由，包括被否决的备选方案；`## Leading Theories` 保留疑似原因及其证据，供后续可能的调查；`## Files and Code` 要求行号。先前检查点的合并规则不再告诉模型「丢弃陈旧事实」，而是要求把先前的工作日志、学到的事实、陷阱与仍然相关的内容继承下来，同时用后续对话刷新状态段落。简洁方向的措辞（「使用简短项目符号，不要散文段落」「Write concise English engineering prose」）被替换为允许项目符号在细节需要时延续数句。

[前缀 cache 注记](2026-07-21-compaction-summary-prefix-cache-reuse.md)所拥有的位置约定不变：指令仍是追加在字节级一致的回放前缀之后的尾部 user 消息，因此 KV Cache 复用不受影响。[英文检查点注记](2026-07-31-english-compaction-checkpoints.md)的英文语域要求保留在开篇句中，该句现在同时承载两项策略（「…a comprehensive, detailed checkpoint in English…」）。

## 已考虑的备选方案

- **保留简洁措辞，仅增加工作日志段落** —— 否决：实践中「浓缩」与「简洁」指令会压倒段落的存在；被要求保持简短的模型会首先删减新段落。
- **用显式预算限制摘要大小** —— 否决：指令声明的任何预算都已被请求的 `maxTokens` 上限强制执行，而声明预算会重新引入本变更所移除的删减动机。
- **允许各部署在配置中覆盖指令** —— 否决：指令的尾部位置与其精确合并规则是[前缀 cache 注记](2026-07-21-compaction-summary-prefix-cache-reuse.md)所拥有的检查点约定的一部分；自由形式的覆盖会让部署静默破坏两者。

## 影响

- 检查点变得更大、更丰富：它们在各周期之间保留按时间顺序的历史、学到的事实与假设，而不是坍缩为当前状态。持久的替换 user 消息及此后每个回放前缀随之增长，因此相比简短摘要，每次压缩缓解上下文压力的力度会减弱。
- 摘要输出更常逼近 `maxTokens` 上限（默认 8192）；`finishError` 中的快速失败式 `MAX_TOKENS` 处理会丢弃被截断的检查点而非落盘不完整检查点，因此失败形态是跳过压缩，而非静默丢失。
- `compaction-basic.spec.ts` 与 `compaction-loop-repro.spec.ts` 中的内容断言跟踪新的规则措辞；`## Primary Request and Intent` 标题与 "acting as a compaction engine" 开篇语仍是循环复现测试用来识别摘要请求的稳定标记。
