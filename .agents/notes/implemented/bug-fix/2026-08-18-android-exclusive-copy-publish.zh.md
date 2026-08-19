# Agent Note: Android exclusive-copy no-replace publication

Status: implemented

[English](2026-08-18-android-exclusive-copy-publish.md) | 中文

## Problem

有三处持久化边界用 `link()` 把写完并 fsync 过的暂存文件发布到最终名字——选它而非 `rename()`，是因为 `link()` 在目标已存在时以 EEXIST 失败，两个并发写入者因此不可能互相覆盖：`dsh-session-persistence-jsonl` 物化会话日志（见 [Windows 持久发布决策](../architecture/2026-07-05-windows-jsonl-durable-publish.md)）、`dsh-attachment-local` 发布内容寻址对象、以及 `dsh-fs-local` 的 `createIfAbsent` 守护写入（见[缺席观测决策](../bug-fix/2026-08-09-filesystem-absence-observation.md)）。

Android 存储没有可用的硬链接：SELinux 拒绝不受信应用在应用私有存储里调用 `link()`，而 sdcardfs（共享存储，即 agent 工作区）完全不支持硬链接。这三处写入在设备上全部以 EACCES/EPERM 失败——观察到的症状是首个聊天回合报错 `EACCES: permission denied, link '…session.jsonl.zstd.….tmp' -> '…session.jsonl.zstd'`。符号链接是与之相关的不对称：在应用私有存储可用，在共享存储上则以 EACCES 失败。

## Decision

每个站点保留其暂存写入与 EEXIST 不覆盖契约，但在 `process.platform === 'android'` 时分派到 `copyFile(tmp, target, COPYFILE_EXCL)` 发布——独占复制与 `link()` 一样以 EEXIST 失败，因此喂入相同的碰撞映射（`rejectExistingLog`、去重校验、`FS_NOT_OBSERVED`）。复制内容在调用方的目录同步之前完成 fsync（`fs-local` 中还会 chmod 到暂存文件的 0o600)，因此发布内容达到与被链接 inode 相同的持久化标准。

被接受的代价：在独占创建与复制完成之间崩溃，可能留下内容不完整的最终路径，而 `link()` 原子地发布完整内容。Node 无法触及无覆盖重命名原语（renameat2 `RENAME_NOREPLACE`)。对于附件存储，撕裂的对象会在下一次存储相同哈希时响亮地 fail 完整性校验，而不是静默地去重到坏对象上。

`fs-local` 的分支通过既有 `internals.platform` / `internals.copyFileExclusive` 接缝在单元测试里钉住；另两处分支沿用 Windows 先例携带 v8 ignore，因为覆盖率主机从不运行 Android。

## Alternatives considered

**运行时探测 link 失败后回退。** 否决：平台分派与既有 win32 先例一致，失败面保持确定，也避免把真实的 EEXIST 碰撞与硬链接支持缺失混为一谈——这正是 `fs-local` 守护失败映射本来就不得不分辨的歧义。

**用符号链接做不覆盖守卫。** 否决：symlink 创建同样以 EEXIST 失败，但符号链接形态的会话日志会被后端自己的 `readdir` 列表忽略（`Dirent.isFile()` 排除符号链接），且共享存储上符号链接直接被拒。

**在 `dsh-atomic-write` 里放一个共享 helper。** 暂否决：每个站点各有不同的持久化流程（目录 fsync 次序、去重校验、DACL 处理），共享核心只有十行，新增跨包依赖边的代价高于这点重复。

## Consequences

会话物化、附件存储与守护式文件创建在 Android 上可用；首回合 EACCES 已消失（通过重新打包的闭包在设备上验证）。非 Android 行为逐字节不变——link 分支未动，仍是每个 CI 主机上的被覆盖路径。Android 分支用一个小小的崩溃原子性窗口换来了平台可达性，已在各处就地记录。
