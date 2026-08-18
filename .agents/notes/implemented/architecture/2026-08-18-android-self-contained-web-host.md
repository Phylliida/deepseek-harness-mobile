# Agent Note: Self-contained Android web host under mobile/

Status: implemented

English | [中文](2026-08-18-android-self-contained-web-host.zh.md)

## Problem

The harness ran only on desktop Node; there was no way to carry an agent session on an Android phone. A mobile port must run the full host on-device — the plugin runtime, `node:sqlite`-backed session storage, and the web UI — without dropping to an older Node or proxying through a remote server, and the harness requires Node `^22.19 || >=24` for `node:sqlite` and current engine APIs.

## Decision

`mobile/` is a self-contained Capacitor 6 Android app that runs the DeepSeek Harness web host on-device and points a WebView at it. The directory is deliberately outside the pnpm workspace, with one exception: `mobile/deploy-root` is a workspace member that exists only as the `pnpm deploy` manifest defining the on-device closure.

The launcher page (`mobile/www`, served from Capacitor assets at `https://localhost`) drives a small Java runtime under `mobile/android/app/src/main/java/dev/phylliida/dsh/`. `NodeRunnerService` is a foreground service; `NodeRuntime` extracts a bundled `runtime.tgz` into app-private storage (`getFilesDir()/runtime`, ext4/f2fs, so symlinks and exec permission survive) and spawns a Termux-built Node running `dsh --profile web --port 0`. When stdout prints the readiness line `dsh web: http://127.0.0.1:<port>`, the WebView navigates to that URL; from then on all UI, RPC, and WebSocket traffic is same-origin on loopback. There is no proxying and no mixed content.

Node itself comes from Termux packages: `mobile/scripts/fetch-termux-node.mjs` resolves and downloads the `nodejs` `.deb` plus its shared-library dependencies from the Termux apt mirror, pinned by SHA-256 in `mobile/runtime/termux.lock.json` (currently Node 26.4.0). The harness payload is a `pnpm deploy --legacy --prod` closure over `mobile/deploy-root/package.json` (`dsh-mobile-web-pkg`), materialized symlink-free by `mobile/scripts/package-runtime.mjs` (which mirrors `scripts/build-exe-for-python-sdk.ts`) and packed with the Node rootfs into `mobile/android/app/src/main/assets/runtime.tgz`.

The folder model keeps user data on shared storage: the user picks a folder as the agent workspace, which becomes the Node process's `cwd` and the sandbox `workspaceRoot`. `DSH_HOME` is probed at pick time (`DshMobilePlugin` attempts `Os.symlink` with a `.dsh-symlink-probe` file) because the profile module fallback requires symlinks and sdcardfs rejects them; if the picked folder supports symlinks it becomes `DSH_HOME`, otherwise `DSH_HOME` falls back to app-private storage.

## Android and packaging constraints

Native modules with no Android build are statically imported by mounted rows — node-pty (`dsh-subprocess-local`), koffi (`dsh-sandbox-windows-acl`'s `ffi.ts`, evaluated at module scope for struct declarations, Windows-only uses), and sharp (`dsh-attachment-local`). `mobile/scripts/package-runtime.mjs` replaces each in the deployed closure with a load-safe stub (`NEUTRALIZED_NATIVE_MODULES`) that throws loudly at first real use, so bash/pwsh tool calls, the ACL sandbox, and image attachments fail loudly per call while the service graph stays intact. (The first draft disabled the base `subprocess` row via `mobile/patches/mobile.cordis.patch.yml` instead; that left `bash-sandbox` and `permission-presets` pending on the missing `subprocess`/`shell` services and failed the boot, so the rows stay mounted and the modules are neutralized. The overlay is kept as an empty list — the seam for future Android-only overrides.) The node process is spawned with `--expose-internals`, which the vendored cordis loader requires to resolve bare profile plugin names against the profile baseUrl; the alternative resolution path depends on the `node-addon-require-builtin` native module, which has no Android build.

The APK targets `targetSdk 28`, the Termux model: it keeps `exec` from app-private storage working and preserves legacy shared-storage semantics. The app is sideload-only and never targets Play. Debug signing uses a committed standard debug keystore (`mobile/android/app/dsh-debug.keystore`, the standard `android`/`androiddebugkey` credentials) so `adb install -r` upgrades install over the previous build; the pattern and CI are modeled on `ref/memki`, the reference Capacitor+F-Droid setup. `.github/workflows/android-build.yml` builds the debug APK and publishes the `dsh-debug-apk` artifact.

## Alternatives considered

**Capacitor-NodeJS / nodejs-mobile** — the established way to embed Node in a mobile app, but it is pinned to Node 18.20, and the harness requires `^22.19 || >=24` and uses `node:sqlite`. Unpacking current Termux `.deb`s gets a maintained, current Node with ordinary shared-library dependencies rather than a patched engine fork.

**targetSdk 34 with modern storage rules** — current Play policy, but it blocks executing the extracted Node binary from app-private storage and routes shared storage through scoped-storage APIs the folder-pick model does not want. Sideload-only distribution makes the older target viable; accepting it forecloses Play Store eligibility, which this distribution pattern never intended to use.

**Proxying the WebView through `https://localhost`** — keeping the WebView origin on the Capacitor scheme and tunneling requests to Node avoids a cross-origin jump, but adds a proxy layer, an origin mismatch to reason about, and mixed-auth surface. Navigating the WebView to the loopback Node server once the port is known keeps everything same-origin with no extra moving part.

**Login shell or bundled busybox for bash/subprocess on-device** — shipping an Android-capable PTY layer would keep the bash tool alive, but node-pty has no Android binary and Termux's own PTY setup is out of scope for the packaging pipeline. A load-time stub is a packaging step, not a fork, and failures stay loud at tool use.

## Consequences

The app runs a full unmodified harness web profile on-device with current Node; upgrades ride the Termux package mirror, repinning `termux.lock.json`, and every build is reproducible from the committed keystore, lockfile, and deploy manifest. Sideload-only distribution with targetSdk 28 means no Play Store eligibility, ever, by design. Android 12+'s phantom process killer can kill a backgrounded busy Node process — the workaround (disabling the killer via `adb`) is documented in `mobile/README.md`. The on-device loopback host has no auth layer, unchanged from the upstream stance for loopback serving. The subprocess/bash capability is unavailable on-device and calls fail loudly. First launch extracts `runtime.tgz` (~90 MB payload) into app-private storage, which takes up to a minute.
