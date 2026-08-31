# Agent Note: 沙箱设备透传——以经过验证的提供方配置实现 GPU 访问

Status: implemented

[English](2026-08-31-sandbox-device-passthrough.md) | 中文

## Problem

本地沙箱的 Linux profile 使受限命令无法触及设备节点：bwrap 构建一个最小化的 `/dev` tmpfs（仅 null、zero、full、random、urandom、tty、pts、ptmx、shm），而 Landlock profile 唯一的可读写设备授权是 `/dev/null`。GPU 工作——CUDA 计算、NVML 查询、DRM 渲染——因此在任何模式下都会失败；操作方仅有的出路是每次命令被拒时批准一次提升，或让整个会话运行在 `danger-full-access` 之下，而后者在只需要少数几个设备节点时放弃了整个文件操作边界。

## Decision

`dsh-sandbox-local` 接受 `devicePassthrough: string[]`：以可读写方式暴露给每条受限命令的宿主机设备节点。bwrap 档为每个条目追加一对 `--dev-bind <节点> <节点>`，Landlock 档为每个条目追加一项 `--rw` 授权（launcher 对非目录规则在 ABI ≥ 5 时保留 `LL_FS_IOCTL_DEV`，因此渲染与计算节点上的 ioctl 可用），配置了 `runnerCommand` 时也会收到同样的 bwrap 参数对。Seatbelt 与 windows-acl 档忽略该列表——这两个平台都不通过可写设备节点暴露 GPU。

条目在插件加载时验证：每个必须是规范化后位于 `/dev/` 之下的绝对路径——`/dev` 本身会被拒绝（整树绑定会暴露 `/dev/shm`、`/dev/pts` 以及所有无关节点），`..` 逃逸（如 `/dev/../etc/hostname`）同样被拒绝——并且必须存在于宿主机上。违规在挂载时抛出，遵循配置错误立即失败（fail loud）的规则；加载后消失的节点会在包装时通过 runner 自身的致命方言失败（bwrap 的 `Can't find source path`，launcher 的 `cannot open rule path`），消费方本就把这类失败归类为沙箱故障而非命令失败。

此授权在构造上与模式无关：各模式约束的是普通文件树上的文件操作，而设备节点是部署方主动选择接入的宿主机能力。`read-only` 仍然约束其余一切，进程内 fs 围栏（`dsh-fs-sandbox`）不受影响——fs 工具仍无法写入设备节点。runner 选择、探测、缓存与拒绝语义仍按[沙箱 Agent Note](2026-07-06-sandbox.md) 所述。

## Alternatives considered

- **整树 `/dev` 透传**（`--dev-bind /dev /dev`）：一行即可且与厂商无关，但它把 `/dev/shm`（宿主机所有进程的共享内存）、`/dev/pts` 以及任务从不接触的硬件节点一并交给受限命令——远比 GPU 访问所需的边界宽。
- **`gpu: true` 预设**：把一份特定厂商、特定卡数的节点列表硬编码进插件，违反无硬编码可调项规则；节点集合在 NVIDIA、AMD（`/dev/kfd`）、Intel 及 MIG 配置之间各不相同，因此显式列表才是诚实的约定。
- **逐调用的 `SandboxPolicy` 字段**：设备访问是部署属性，不是逐调用的决定；策略载体服务于确实逐调用变化的模式与根目录，且没有消费方要求逐调用的设备控制。
- **`runnerCommand` 包装脚本逃生舱**：操作方脚本今天就能零代码注入 `--dev-bind` 参数，但它跳过探测、用 shell 重新实现 profile 组装，且其用途是认证自定义 runner——而不是承载主流的 GPU 需求。

## Consequences

部署方列出节点后，GPU 命令（CUDA、`nvidia-smi`、VA-API 渲染）即可在受限状态下运行，不再出现提升审批提示；枚举宿主机 `/dev` 仍是操作方的责任，并在挂载时得到验证。边界会有意识地对列出的节点在任何模式下放宽，包括 `read-only`——已在包 README 的已知限制中记录。加载时的存在性验证意味着：若宿主机的 GPU 节点仅在模块延迟加载后才出现，则必须在节点存在后挂载该插件。单元测试固定了 argv 方言与每个验证分支；真实 bwrap 的 e2e 在 GPU 宿主机上证明节点可见性，在其他环境自行跳过。
