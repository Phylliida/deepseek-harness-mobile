# Agent Note: `allowUnobservedMutation` config for the fs observation policy

Status: implemented

[English](2026-08-15-fs-policy-unobserved-mutation-config.md) | 中文

## Problem

[file-context-as-event-gate Agent Note](../architecture/2026-06-26-file-context-as-event-gate.md) 使 `dsh-fs-observation-policy` 成为可选插件：移除它，文件系统工具就无条件运行（无写入/编辑前读取）；加载它，则任何对未观测的现有文件的写入或编辑都会以 `FS_NOT_OBSERVED` 失败。有些部署想要两极之间的立场——智能体经常通过其他渠道获得文件内容（grep 结果、diff、任务描述），为它已知的文件付出强制 `read` 的往返和 token 成本，而全有或全无的插件移除又同时放弃了版本 CAS 防护——后者能捕获它*确实*读取过的文件上发生的带外变更。唯一的退路是丢弃整个策略。

## Decision

`dsh-fs-observation-policy` 获得一个经 schemastery 校验的 `Config`，包含一个字段：

```ts ignore-check
interface Config {
  allowUnobservedMutation?: boolean  // default false
}
```

`false`（默认值；随附的 bundle 保持它）精确保持文档记录的决策。`true` 仅放宽两个意图监听器中**未见**目标的决策：

- `fs/write-intent`：未见 ⇒ `undefined`（落到裸提供方的无条件写入），而不是 `createIfAbsent`，因此覆盖未观测的现有文件不再因 `FS_NOT_OBSERVED` 失败。
- `fs/edit-intent`：未见 ⇒ `undefined`（提供方无条件编辑），而不是抛出 `FS_NOT_OBSERVED`。

在两种模式下，已确认的观测仍然参与决策：已观测为存在保留其 CAS 防护（`replaceIfVersion` / `{ version }`，因此观测后发生的外部变更仍然以 `FS_STALE_VERSION` 失败），已观测为缺失保留 `createIfAbsent` / `FS_NOT_FOUND`。所有者推导、`fs/observed` 记录约定和单 slot 先到者胜约定均不变，与 event-gate Note 的机制一致。面向模型的工具提示文本不变：它早已把“读取优先”的指导措辞限定为“default fs-observation-policy”的条件。

## Alternatives considered

- **在部署的 cordis.yml 中移除该插件**——先前记录的退路；会整体失去 CAS 防护，使读取不再带来任何陈旧变更保护，且单一的全部署开关无法为智能体读取过的文件保留 `FS_STALE_VERSION`。
- **两个开关（`allowUnobservedWrite` / `allowUnobservedEdit`）**——粒度更细但没有依据：没有消费方要求只放宽一种变更而不放宽另一种，且 [`dsh-find-simplifications`](../../../skills/dsh-find-simplifications/SKILL.md) 政策不鼓励推测性的选项集合；只有当真实部署需要这种不对称时才拆分。
- **同时放宽已观测为缺失的决策**（对记录为缺失的目标无条件编辑）——被拒绝：缺失是已确认的观测，这里的防护所捕获的不一致（编辑智能体认为缺失的文件）是值得暴露的模型错误，而不是节省 token 的场景。

## Consequences

- **宽松模式恰好在被配置的位置削弱了盲目覆盖的威慑。** 未见目标的覆盖无法报告它摧毁的陈旧内容；部署的选择加入使得这对于带外获得文件内容的智能体而言是可接受的。智能体读取过的文件仍受 CAS 保护，这正是移除插件无法提供的中间立场价值。
- **随附的默认值和每个现有快照/转录均不变。** 宽松行为只能通过显式的 cordis.yml 配置触及，使选择加入的行为远离随附默认值。
- **非工具覆盖在任一模式下都未变且不完整。** 在 `read` 工具之外的读取（`ctx.fs.readText`、shell `cat`、grep 输出）仍然不记录观测；宽松模式让这一缺口对变更授权无害，而不是消除它。

## Testing

`dsh-fs-observation-policy` 的单元测试固定了 `allowUnobservedMutation: true` 下的六种决策结果（未见写入/编辑落空、已观测为存在的 CAS 完好、已观测为缺失不变），严格默认值仍由现有套件固定；`dsh-tool-fs` 集成测试针对真实的本地后端端到端演练宽松部署：未观测的覆盖/编辑成功，已观测文件的陈旧写入仍以 `FS_STALE_VERSION` 失败，编辑已观测为缺失的目标仍以 `FS_NOT_FOUND` 失败。
