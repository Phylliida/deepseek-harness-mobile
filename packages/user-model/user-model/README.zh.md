# @deepseek-ai/dsh-user-model

[English](README.md) | 中文

模型用户伴随域：用户模型特性的类型、持久事件、日志折叠、提示词构建器、解析器，以及唯一的共享辅助生成调用。用户模型是第二个可选模型，扮演用户角色：启用时接收目标，在智能体停滞时作答，回答智能体的问题与审批请求，并自行判定目标完成。[`user-model-driver`](../user-model-driver/README.md) 组合驾驭循环；apiproxy 的 `session.selectUserModel` RPC 及其问题／审批转发复用同一套定义。

## 组合

```yaml
- id: user-model
  name: '@deepseek-ai/dsh-user-model'
```

该插件在组合了投影注册表时注册 `userModel` 会话投影（当前启用选择或 null）。它没有配置项，也不提供自己的 `ctx` 服务；启用与停用是由消费者（`session.selectUserModel`、驱动器）执行的会话日志变更。

## 持久事实

启用选择 `{ provider, model, prompt }` 以 `user-model/armed` 事件落在会话日志上，`user-model/disarmed { reason }` 结束它。`readUserModelSelection` 对这对事件做反向折叠，因此驱动器、apiproxy 转发缝、`userModel` 投影以及冷恢复的会话都读取同一个事实，不依赖进程内持有。每个会话一个用户模型：重新启用即追加新的 armed 事件，替换原选择。

每次辅助生成都经过 `callUserModel`：它在派发前把确切请求追加为 log-only 的 `user-model/request` 事件——模型可见边界只记录一次、形状唯一，无论驾驭作答、问题回答还是审批裁决。非 `stop` 的结束原因（错误、中止、达到 max-tokens、工具调用）或空文本都使调用失败。

## 回复不是人类消息

用户模型的输出以 `source.kind` 为声明合并出的 `user-model` 种类（`{ kind: 'user-model', provider, model }`）的 `user/message` 事件进入会话，绝不使用普通的 `user` 种类——标题生成与技能扫描仍然只看到人类键入的消息。完成哨兵 `<task-complete/>` 必须位于回复末尾；其前的文本作为收尾反馈送达，驱动器随即以 `complete` 原因停用。`parseUserModelQuestions` 与 `parseUserModelApproval` 提取 apiproxy 转发所期望的结构化答案。

## 模型体验

### 人设提示词

#### 模型看到的内容

系统提示词将其设定为对话中的用户，携带人类的目标文本；外加角色翻转后的会话转录（智能体的 assistant 消息成为 user 角色上下文，反之亦然），使其从用户视角阅读会话。问题与审批请求附加一条框架消息，列出确切的问题或待决调用，并要求机器可解析的回复。回复可以以 `<task-complete/>` 哨兵结尾，宣告目标完成。

#### Token 影响

每次辅助调用都重发人设与派生转录；除会话日志本身外，调用之间没有保留状态。

#### KV Cache 影响

辅助调用发往启用的 provider/model 路由，与会话模型的缓存情形相互独立。

## 已知限制与暂缓事项

- **无路由智能** —— 本域只提供折叠与构建器；何时回复、何时转发问题、何时停用，属于驱动器与 apiproxy 的职责。
- **每会话一个用户模型** —— 不存在模拟用户面板；多智能体聊天仍是暂缓事项。
