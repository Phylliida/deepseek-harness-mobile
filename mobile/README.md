# mobile/ — Self-contained Android app

English | [中文](README.zh.md)

A Capacitor 6 shell that runs the **full harness host on-device**: the launcher WebView starts a foreground service that extracts a bundled runtime and boots `dsh --profile web --port 0` on loopback (node is spawned with `--expose-internals`, which the vendored cordis loader requires to resolve profile plugin names against the profile baseUrl); once the readiness line `dsh web: http://127.0.0.1:<port>` appears, the WebView navigates to that URL and the ordinary web UI takes over — all RPC/WebSocket traffic stays same-origin. No external server.

## Layout

- `package.json`, `capacitor.config.json`, `package-lock.json` — a standalone **npm** project (deliberately outside the pnpm workspace; only `deploy-root/` is a workspace member).
- `www/` — launcher page (status, storage permission, folder pick, node log tail) served from the capacitor `https://localhost` origin until the node port is known.
- `android/` — committed Capacitor Android project: `minSdk 26`, `targetSdk 28` (see below), debug signing pinned to the committed `app/dsh-debug.keystore` (standard `android`/`androiddebugkey` creds, public debug key, same pattern as `ref/memki`) so `adb install -r` upgrades work across builds.
- `scripts/fetch-termux-node.mjs` — downloads a pinned Termux-built Node.js + shared-library closure (`runtime/termux.lock.json` holds URLs + sha256; `--refresh` re-pins). Termux is used because the harness needs Node `^22.19 || >=24` and nodejs-mobile is stuck on Node 18.
- `scripts/package-runtime.mjs` — `pnpm deploy` of `deploy-root/` (name `dsh-mobile-web-pkg`) into a symlink-free closure, then neutralizes the native modules with no Android build that mounted rows statically import — node-pty (`dsh-subprocess-local`), koffi (`dsh-sandbox-windows-acl`, Windows-only uses), sharp (`dsh-attachment-local`) — with stubs that load cleanly and throw at use, so the host boots and the affected capability fails loudly per call. The closure plus node rootfs are packed into `android/app/src/main/assets/runtime.tgz` (created with `tar --hard-dereference`: hard links are SELinux-denied in app-private storage).
- `deploy-root/package.json` — dependency-only manifest defining the on-device web-host closure.
- `patches/mobile.cordis.patch.yml` — `--patch` overlay, currently an empty list; the seam for future Android-only overrides (disabling a row cascades into every entry waiting on its service and fails the boot, so prefer neutralizing bad modules over disabling rows).

## targetSdk 28 — read this first

The APK is **sideload-only**. targetSdk 28 keeps two behaviors the design relies on: executing the extracted `bin/node` from app-private storage (blocked for targetSdk ≥ 29) and legacy shared-storage semantics (raw file paths under `/sdcard` with the `WRITE_EXTERNAL_STORAGE` runtime permission). Google Play requires current targetSdk levels, so this app can never ship there.

## Folders and data

The user picks a folder on primary shared storage (document-tree picker, decoded to a real path). It becomes the agent's **workspace root** (the node process cwd, hence the sandbox `workspaceRoot`). `DSH_HOME` is probed at startup: if the picked folder supports symlinks it hosts `$DSH_HOME`; sdcardfs usually cannot, and then `DSH_HOME` falls back to app-private storage (`files/dsh`) because the profile module fallback writes symlinks. Uninstalling the app deletes the internal fallback but never the picked folder.

Node runs in a **foreground service** with a persistent notification and a partial wake lock. The API key is entered in the web UI's Settings → Models after first boot (host boots keyless; `dsh-credentials-local` persists it under `$DSH_HOME/.credentials.yaml`).

## Known device risks

- **Phantom process killer (Android 12+)**: a backgrounded app whose busy child exceeds CPU limits can be killed. Workaround (once per device): `adb shell settings put global settings_enable_monitor_phantom_procs false` (Android 12/13) or `adb shell device_config put activity_manager max_phantom_processes 2147483647`.
- Bash/pwsh tool calls, the ACL sandbox, and image attachments (sharp/libvips) fail loudly at use — their native modules are stubbed (no Android builds), and the sandbox has no Android runner (deny-closed). File tools, LLM calls, sessions, compaction, subagents, and web search are unaffected.
- The loopback host has no auth layer (unchanged upstream stance): other apps on the device could theoretically reach `127.0.0.1:<random port>`. Debug build, personal use.
- First launch extracts ~90 MB of runtime — can take a minute.

## Build

CI (`.github/workflows/android-build.yml`) is the reference build, mirroring `ref/memki`: repo `pnpm install` + `pnpm run build`, then `node mobile/scripts/fetch-termux-node.mjs && node mobile/scripts/package-runtime.mjs`, then `npm ci` in `mobile/`, `npx cap sync android`, `./gradlew assembleDebug` (JDK 17). Artifact: `dsh-debug-apk`.

Local (needs JDK 17 + Android SDK, pnpm via corepack):

```sh
pnpm install && pnpm run build            # at the repo root
cd mobile
node scripts/fetch-termux-node.mjs        # downloads ~95 MB of Termux packages once
node scripts/package-runtime.mjs          # writes android/app/src/main/assets/runtime.tgz
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

Sideload: `adb install -r app-debug.apk`. All debug builds share the committed debug key, so upgrades never require an uninstall.
