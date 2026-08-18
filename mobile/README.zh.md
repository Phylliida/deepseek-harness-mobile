# mobile/ — 自包含 Android 应用

[English](README.md) | 中文

一个 Capacitor 6 外壳，在设备上运行**完整的 harness 宿主**：启动器 WebView 启动前台服务，解包内置运行时并回环启动 `dsh --profile web --port 0`（node 以 `--expose-internals` 启动——vendored cordis loader 需要它才能按 profile baseUrl 解析插件名）；当 stdout 出现就绪行 `dsh web: http://127.0.0.1:<port>` 时，WebView 跳转到该 URL，常规 Web UI 接管——所有 RPC/WebSocket 流量保持同源。无需外部服务器。

## 目录结构

- `package.json`、`capacitor.config.json`、`package-lock.json` —— 独立的 **npm** 项目（刻意不纳入 pnpm workspace；只有 `deploy-root/` 是 workspace 成员）。
- `www/` —— 启动器页面（状态、存储权限、文件夹选择、node 日志尾部），在 node 端口就绪前由 capacitor `https://localhost` origin 提供。
- `android/` —— 提交入库的 Capacitor Android 工程：`minSdk 26`、`targetSdk 28`（原因见下），debug 签名固定为已提交的 `app/dsh-debug.keystore`（标准 `android`/`androiddebugkey` 口令的公开 debug 密钥，与 `ref/memki` 同款模式），因此各次构建之间可用 `adb install -r` 覆盖升级。
- `scripts/fetch-termux-node.mjs` —— 下载固定版本的 Termux 构建的 Node.js 及共享库闭包（`runtime/termux.lock.json` 记录 URL 与 sha256；`--refresh` 重新固定）。使用 Termux 是因为 harness 需要 Node `^22.19 || >=24`，而 nodejs-mobile 停留在 Node 18。
- `scripts/package-runtime.mjs` —— 对 `deploy-root/`（包名 `dsh-mobile-web-pkg`）执行 `pnpm deploy` 得到无符号链接的闭包，随后将没有 Android 构建、却被已挂载行静态导入的原生模块——node-pty（`dsh-subprocess-local`）、koffi（`dsh-sandbox-windows-acl`，仅 Windows 使用）、sharp（`dsh-attachment-local`）——替换为加载安全、调用时抛错的桩实现，宿主因此能启动，受影响的能力逐次明确报错。闭包与 node rootfs 一起打包为 `android/app/src/main/assets/runtime.tgz`（用 `tar --hard-dereference` 打包：应用私有存储中硬链接被 SELinux 拒绝）。
- `deploy-root/package.json` —— 仅声明依赖的清单，定义设备端 web 宿主闭包。
- `patches/mobile.cordis.patch.yml` —— 经 `--patch` 应用的叠加层，目前是空列表，作为未来 Android 专属覆盖的接缝（停用行会级联到所有等待其服务的条目，导致启动失败，因此优先中和一个坏模块而不是停用行）。

## targetSdk 28 —— 请先阅读

此 APK **仅供侧载**。targetSdk 28 保留了该设计依赖的两项行为：从应用私有存储执行解压出的 `bin/node`（targetSdk ≥ 29 被禁止），以及旧版共享存储语义（凭 `WRITE_EXTERNAL_STORAGE` 运行时权限按原始路径访问 `/sdcard`）。Google Play 要求现行 targetSdk 等级，因此此应用永远无法上架 Play。

## 文件夹与数据

用户在主共享存储上选择一个文件夹（系统目录选择器，解码为真实路径）。它成为 agent 的**工作区根目录**（node 进程 cwd，即沙箱 `workspaceRoot`）。启动时探测 `DSH_HOME`：若所选文件夹支持符号链接，则 `$DSH_HOME` 放在其中；sdcardfs 通常不支持，此时 `DSH_HOME` 回退到应用私有存储（`files/dsh`），因为 profile 模块回退机制需要写符号链接。卸载应用会删除内部回退数据，但不会触及所选文件夹。

Node 运行在**前台服务**中，带常驻通知与部分唤醒锁。首次启动后在 Web UI 的 设置 → 模型 中输入 API key（宿主可无密钥启动；`dsh-credentials-local` 将其持久化到 `$DSH_HOME/.credentials.yaml`）。

## 已知设备风险

- **幽灵进程杀手（Android 12+）**：应用退到后台后，其繁忙子进程超出 CPU 限额可能被杀死。规避方法（每台设备一次）：`adb shell settings put global settings_enable_monitor_phantom_procs false`（Android 12/13），或 `adb shell device_config put activity_manager max_phantom_processes 2147483647`。
- bash/pwsh 工具调用、ACL 沙箱与图片附件（sharp/libvips）在使用时明确报错——其原生模块已被桩替换（无 Android 构建），沙箱也没有 Android runner（拒绝放行）。文件工具、LLM 调用、会话、压缩、子代理与网页搜索不受影响。
- 回环宿主没有认证层（上游既有立场）：设备上其他应用理论上可访问 `127.0.0.1:<随机端口>`。debug 构建，个人使用。
- 首次启动需解压约 90 MB 运行时——可能耗时一分钟。

## 构建

CI（`.github/workflows/android-build.yml`）是参考构建，沿用 `ref/memki` 的流程：仓库根 `pnpm install` + `pnpm run build`，然后 `node mobile/scripts/fetch-termux-node.mjs && node scripts/package-runtime.mjs`（在 `mobile/` 目录），再 `npm ci`、`npx cap sync android`、`./gradlew assembleDebug`（JDK 17）。产物名：`dsh-debug-apk`。

本地构建（需要 JDK 17 + Android SDK，pnpm 经 corepack 调用）：

```sh
pnpm install && pnpm run build            # at the repo root
cd mobile
node scripts/fetch-termux-node.mjs        # downloads ~95 MB of Termux packages once
node scripts/package-runtime.mjs          # writes android/app/src/main/assets/runtime.tgz
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

侧载：`adb install -r app-debug.apk`。所有 debug 构建共用已提交的 debug 密钥，升级无需先卸载。
