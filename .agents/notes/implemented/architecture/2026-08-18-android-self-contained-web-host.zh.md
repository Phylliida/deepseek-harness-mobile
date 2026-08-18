# Agent Note: mobile/ 下自包含的 Android Web 宿主

Status: implemented

[English](2026-08-18-android-self-contained-web-host.md) | 中文

## 问题

harness 此前只能在桌面 Node 上运行，无法在 Android 手机上随身携带 agent 会话。移动端移植必须在设备上运行完整宿主——插件运行时、基于 `node:sqlite` 的会话存储和 Web UI——不能退化到旧版 Node，也不能通过远程服务器代理；harness 要求 Node `^22.19 || >=24`，以使用 `node:sqlite` 和当前的引擎 API。

## 决策

`mobile/` 是一个自包含的 Capacitor 6 Android 应用，在设备上运行 DeepSeek Harness Web 宿主并将 WebView 指向它。该目录刻意不加入 pnpm workspace，唯一例外是 `mobile/deploy-root`：它是 workspace 成员，仅作为定义设备端依赖闭包的 `pnpm deploy` 清单存在。

启动页（`mobile/www`，由 Capacitor assets 以 `https://localhost` 提供）驱动 `mobile/android/app/src/main/java/dev/phylliida/dsh/` 下的一小组 Java 运行时代码。`NodeRunnerService` 是一个前台服务；`NodeRuntime` 把内置的 `runtime.tgz` 解压到应用私有存储（`getFilesDir()/runtime`，ext4/f2fs，符号链接和可执行权限得以保留），并启动一个 Termux 构建的 Node 运行 `dsh --profile web --port 0`。当 stdout 打印出就绪行 `dsh web: http://127.0.0.1:<port>` 时，WebView 导航到该 URL；此后所有 UI、RPC 和 WebSocket 流量都在 loopback 上同源。没有代理，也没有混合内容。

Node 本身来自 Termux 软件包：`mobile/scripts/fetch-termux-node.mjs` 从 Termux apt 镜像解析并下载 `nodejs` 的 `.deb` 及其共享库依赖，由 `mobile/runtime/termux.lock.json` 以 SHA-256 锁定（当前为 Node 26.4.0）。harness 载荷是对 `mobile/deploy-root/package.json`（`dsh-mobile-web-pkg`）执行 `pnpm deploy --legacy --prod` 得到的闭包，由 `mobile/scripts/package-runtime.mjs`（镜像 `scripts/build-exe-for-python-sdk.ts` 的做法）以无符号链接形式物化，并与 Node rootfs 一起打包进 `mobile/android/app/src/main/assets/runtime.tgz`。

文件夹模型把用户数据放在共享存储上：用户选择一个文件夹作为 agent 工作区，它成为 Node 进程的 `cwd` 和沙箱的 `workspaceRoot`。`DSH_HOME` 在选择时探测（`DshMobilePlugin` 用 `.dsh-symlink-probe` 文件尝试 `Os.symlink`），因为 profile 模块回退需要符号链接而 sdcardfs 拒绝创建；若所选文件夹支持符号链接，它成为 `DSH_HOME`，否则 `DSH_HOME` 回退到应用私有存储。

## Android 与打包约束

node-pty 在模块加载时被静态导入，且没有 Android 二进制；`mobile/scripts/package-runtime.mjs` 将部署闭包中的其实现替换为在调用时才抛错的桩，因此 bash/pwsh 工具调用逐次响亮地失败，而服务图保持完整。（初稿曾改为通过 `mobile/patches/mobile.cordis.patch.yml` 禁用基础 `subprocess` 行；这使 `bash-sandbox` 与 `permission-presets` 因缺少 `subprocess`/`shell` 服务而挂起并导致启动失败，因此保留该行的挂载、改为中和模块。该 overlay 保留为空列表——作为未来 Android 专属覆盖的接缝。）node 进程以 `--expose-internals` 启动——vendored cordis loader 需要它才能按 profile baseUrl 解析裸插件名；另一条解析路径依赖 `node-addon-require-builtin` 原生模块，而没有 Android 构建。

APK 以 `targetSdk 28` 为目标，即 Termux 模型：它保持从应用私有存储 `exec` 可用，并保留旧的共享存储语义。该应用仅限侧载，永不面向 Play。调试签名使用已入库的标准调试 keystore（`mobile/android/app/dsh-debug.keystore`，标准的 `android`/`androiddebugkey` 凭据），使 `adb install -r` 升级可以覆盖先前的构建；该模式和 CI 以 `ref/memki`（参考的 Capacitor+F-Droid 方案）为模板。`.github/workflows/android-build.yml` 构建调试 APK 并发布 `dsh-debug-apk` 构件。

## 曾考虑的替代方案

**Capacitor-NodeJS / nodejs-mobile**——在移动应用中嵌入 Node 的成熟方案，但它停留在 Node 18.20，而 harness 要求 `^22.19 || >=24` 并使用 `node:sqlite`。解包当前的 Termux `.deb` 能得到一个维护中的、带普通共享库依赖的当前版本 Node，而不是打过补丁的引擎分叉。

**targetSdk 34 与现代存储规则**——当前的 Play 政策，但它会阻止从应用私有存储执行解压出的 Node 二进制，并把共享存储经由 scoped-storage API 路由，这不是文件夹选择模型想要的。仅限侧载的分发使旧目标可行；接受它的代价是永远不具备 Play Store 资格，而这种分发模式本就不打算使用 Play。

**通过 `https://localhost` 代理 WebView**——让 WebView 停留在 Capacitor scheme 上并把请求隧道转发到 Node 可以避免跨源跳转，但会增加一个代理层、一个需要推敲的源不匹配问题和混合的认证面。一旦知道端口就把 WebView 导航到 loopback 的 Node 服务器，可以让一切保持同源且不增加活动部件。

**设备端用登录 shell 或内置 busybox 保住 bash/subprocess**——搭载一个支持 Android 的 PTY 层可以保住 bash 工具，但 node-pty 没有 Android 二进制，而 Termux 自己的 PTY 方案超出打包流水线的范围。加载期桩实现是打包步骤而非分叉，且失败在工具使用时保持响亮。

## 后果

应用在设备上运行完整、未改动的 harness web profile 并使用当前版本 Node；升级随 Termux 软件包镜像走，重新锁定 `termux.lock.json` 即可，每次构建都可由已入库的 keystore、锁定文件和 deploy 清单复现。targetSdk 28 的仅限侧载分发意味着按设计永远没有 Play Store 资格。Android 12+ 的 phantom process killer 可能杀死后台繁忙的 Node 进程——变通方法（通过 `adb` 禁用该 killer）记录在 `mobile/README.md`。设备端 loopback 宿主没有认证层，与上游对 loopback 服务的立场一致，未做改动。subprocess/bash 能力在设备上不可用，调用响亮地失败。首次启动需把 `runtime.tgz`（约 90 MB 载荷）解压到应用私有存储，耗时可达一分钟。
