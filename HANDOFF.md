# HANDOFF — deepseek-harness-mobile debugging state (2026-08-18)

You are picking up an in-progress debugging session. Read this before doing anything else.

## What this repo is

A fork of the DeepSeek Harness (plugin-based agent harness on vendored Cordis, pnpm monorepo), newly packaged as a **self-contained Android app** in `mobile/` (committed, on master). Architecture:

- **Capacitor 6 shell** (`mobile/android`, appId `dev.phylliida.dsh`, targetSdk **28** — Termux model: exec from app-private storage + legacy storage semantics; sideload-only, debug-signed with committed `mobile/android/app/dsh-debug.keystore`).
- **On-device host**: a Java `NodeRunnerService` (foreground service) extracts `assets/runtime.tgz` (Termux-built **Node 26** + a pnpm-deployed web-host closure) into `files/runtime/`, spawns `node --expose-internals <deploy>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --patch <deploy>/mobile.cordis.patch.yml --port 0`, watches stdout for `dsh web: http://127.0.0.1:<port>`, then the launcher WebView navigates to that URL. All RPC/WS is same-origin loopback.
- **Folder model**: user picks a shared-storage folder as the agent **workspace** (node cwd). `DSH_HOME` is probed for symlink support; on this device (Pixel-class, Android 15) symlinks on /sdcard fail → `DSH_HOME` = app-private `files/dsh`. Settings/credentials/sessions live in `files/dsh`, NOT in the picked folder (folder being empty is expected).
- **Native modules neutralized at packaging** (`mobile/scripts/package-runtime.mjs`, `NEUTRALIZED_NATIVE_MODULES`): node-pty, koffi, sharp get load-safe stubs that throw at use. bash/pwsh, ACL sandbox, and image attachments fail loudly per call by design.
- CI: `.github/workflows/android-build.yml` builds the debug APK (`dsh-debug-apk` artifact). `dev/` has the nix shell (adb/gh) and `install-android.sh` for sideloading.

**Verified working on-device**: node exec (SELinux `untrusted_app_27` granted), extraction, `node:sqlite`, worker_threads, host boot, UI load, at least one successful settings write (onboarding entry in `files/dsh/settings.yaml`, 18:25).

## The bug — RESOLVED (2026-08-18, second session)

"Apply hangs, then 'signal timed out'" was **not** an RPC/settings/credentials bug. The ranked candidates below are all disproven: `settings.mutate` and `credentials.set` answer in <0.3s both on Linux and on the real on-device host (verified by curl through `adb forward`, including the exact kimi-coding apply sequence against ns `llm-pi-ai`).

Actual root cause: the failing Chrome tab ("DeepSeek Harness") was pointed at a **stale port (44805)** still LISTENing on pid 17815 — a wedged dsh web host from the **previous install** (uid u0_a304, orphaned to init after reinstall; accepts connections, never answers). The browser's 30s `AbortSignal.timeout` (`packages/host/apiproxy/src/fetch/client.ts:315`) then produced "signal timed out". Same zombie owned 40789, which earlier looked like "the host wedged" — misattribution. Diagnostic traps: truncated `/proc/<pid>/cmdline` reads made 17815 look like a `node -e` probe; `/proc/net/tcp` alone misses tcp6 v4-mapped listeners.

Fix applied: `NodeRuntime.killStaleHosts` sweeps same-uid `/proc` cmdline matches before spawning (handles same-install orphans; cross-install zombies like 17815 still need a phone reboot — no root). Details in mobile/TESTING.md "Fourth device contact".

**User actions**: close the stale Chrome tab (127.0.0.1:44805), reboot the phone to clear pid 17815, re-test Apply in the app.

<details><summary>Original (disproven) investigation notes</summary>

In the web UI's Settings → Models, saving a kimi-coding API key ("Apply" in `ProviderEditor`) **hangs, then shows "signal timed out"** — Chrome's `AbortSignal.timeout()` DOMException message, i.e. the host never answered the POST before the caller deadline.

Established facts (all verified this session):

1. The apply path is **pure host RPC, no provider network involved**: `api.settings.mutate` then `api.credentials.set` (`packages/client/ui-settings-models/src/client/ProviderEditor.tsx`, `applyOnce` ~lines 237-300). DNS/internet is irrelevant to THIS bug.
2. Transport: `fetch(POST ${location.origin}/api/<channel>/<endpoint>)` with `{type:'client-request', rpcId, method, payload}` (`packages/client/connection/src/client/rpc.ts`). The exact channel/endpoint string for `settings.mutate` was **not yet pinned down** — find it via `packages/host/apiproxy/src/fetch/handler.ts`, `packages/host/apiproxy/src/api/rpc-map.ts`, and the client api object in `packages/client/connection/src/client/`.
3. Timeline on device: settings.mutate succeeded at 18:25 (onboarding entry landed). `credentials.set` never completed (no `files/dsh/.credentials.yaml`). No `files/dsh/sessions/` dir.
4. Later, the on-device host looked wedged: curl through `adb forward tcp:40789 tcp:40789` timed out even on `GET /`, and the process was CPU-idle (utime/stime flat — await, not spin). CAVEAT: that port may belong to a leftover manual replay node (see leftovers); treat as "host likely wedged or dead", not proof.
5. On Linux, the same deployed closure boots and serves the UI; **RPC POSTs were never tested on Linux** — that's the first thing to do (Phase 1 below).

## Ranked candidate root causes

1. **An interaction/approval prompt with no answer path in the mobile UI** — the mutation awaits user interaction the mobile surface never provides, stalling past the AbortSignal deadline. Check how settings/credentials writes interact with `packages/interaction/*`.
2. **Settings writer lock**: `packages/util/atomic-write` + `packages/settings/settings-file` — lock acquired across an await that never completes (lock-file handling, flock semantics).
3. **Credentials provider hang**: `packages/credentials/credentials-local` (writes `$DSH_HOME/.credentials.yaml`) blocking on fs.watch/chokidar quirks.
4. **Host actually exits (fail-loud `installFailLoud` on unhandledRejection → process.exit(1))** and the UI's fetch wedges on the dying socket. Distinguish hang-vs-exit in the repro (watch process lifetime).

</details>

## How to reproduce (Phase 1: Linux, do this FIRST)

The deployed closure is already staged at `mobile/runtime/deploy/` (matches the phone build). pnpm via `corepack pnpm` only. Node on this NixOS box is `/run/current-system/sw/bin/node`. Bash tool calls are fresh shells (re-`cd`/re-export each time).

```sh
rm -rf /tmp/dsh-mobile-smoke && mkdir -p /tmp/dsh-mobile-smoke/home /tmp/dsh-mobile-smoke/dsh /tmp/dsh-mobile-smoke/work
cd /tmp/dsh-mobile-smoke/work
env -i HOME=/tmp/dsh-mobile-smoke/home TMPDIR=/tmp DSH_HOME=/tmp/dsh-mobile-smoke/dsh \
  DSH_TELEMETRY_DISABLED=1 PATH=/run/current-system/sw/bin:/usr/bin:/bin nohup \
  node --expose-internals \
  /home/bepis/prog/deepseek-harness-mobile/mobile/runtime/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --patch /home/bepis/prog/deepseek-harness-mobile/mobile/runtime/deploy/mobile.cordis.patch.yml \
  --port 0 > boot.log 2>&1 &
# poll: grep "dsh web:" boot.log  →  dsh web: http://127.0.0.1:<port>
# cleanup: pkill -f "expose-internals /home/bepis"
```

Then `curl` the real `settings.mutate` and `credentials.set` RPCs (mirror the browser client's URL/body from `packages/client/connection/src/client/rpc.ts`; the UI sends an `AbortSignal.timeout(N)` — find N and where it's created). Watch: does it hang? does the host process exit? Check for lock files under `$DSH_HOME` mid-hang.

If it reproduces on Linux → debug there (attach `node --inspect`, add temp logging, whatever's fastest). If it does NOT reproduce → Phase 2.

## Phase 2: on-device reproduction

Phone is USB-connected, adb via nix: `cd dev && nix-shell --run "adb -s 39191FDJH00HME ..."`. Serial: `39191FDJH00HME`.

**run-as caveats (cost a lot of time; internalize them)**:

- `run-as dev.phylliida.dsh` children do **NOT** have inet gid 3003 → UDP EPERM / TCP ETIMEDOUT. Network probes via run-as are artifacts. The real app node HAS gid 3003 (verified in /proc/<pid>/status Groups).
- run-as also lacks the app's mount namespace for /sdcard → raw-path denies via run-as are artifacts. The real app has `LEGACY_STORAGE: allow` + `WRITE_EXTERNAL_STORAGE: granted`; real-app /sdcard behavior is still unverified.
- Therefore the on-device replay reproduces everything EXCEPT networking — fine for this bug (apply is network-free).

Replay recipe: pipe a script into `adb shell "run-as dev.phylliida.dsh sh -s"`, redirect output to `files/manual-run.log`, with env: `HOME=files/home TMPDIR=files/tmp DSH_HOME=files/dsh LD_LIBRARY_PATH=<files/runtime/rootfs/.../usr/lib> PATH=/system/bin:/system/xbin SHELL=/system/bin/sh LANG=en_US.UTF-8 DSH_TELEMETRY_DISABLED=1`, cwd `/storage/emulated/0/DSH`, args identical to the app's spawn (see Architecture). Keep the script boring — toybox `sh` chokes silently on things like `export -n`.

Finding the live port: `/proc/net/tcp` (tcp4, field 2 hex `0100007F:PPPP`, state 0A=LISTEN). **My earlier scan missed tcp6 rows — app binds tcp4 127.0.0.1 so that's fine, but verify the PID before trusting a port**: leftover zombie nodes from my probing may be listening (see below).

`adb forward tcp:<port> tcp:<port>` then curl from the host box to drive the replay host's API directly.

**Leftovers to clean on the device**: pid 17815 = my leftover net-probe node; a manual replay node may still hold 127.0.0.1:40789. Rebooting the phone or `force-stop` + manual kill cleanup avoids misattribution.

## Other loose ends (post-bug backlog)

- **DNS preload not wired**: Termux's c-ares likely can't find a resolver config on-device (run-as probes showed ECONNREFUSED/ENOTFOUND, though those are partially artifacts — real-app DNS is unverified). A preload exists on-device at `files/runtime/deploy/android-preload.cjs` (calls `dns.setServers([8.8.8.8, ...])`) but the Java spawn does NOT pass `--require`. If real-app LLM calls fail DNS later, wire `--require <deploy>/android-preload.cjs` into `NodeRuntime` and add the file in `package-runtime.mjs`.
- **Stale-node risk**: a node from a previous install (different uid) was still running after reinstall — **this turned out to be the root cause of the "signal timed out" bug** (see above). `NodeRuntime.killStaleHosts` now sweeps same-uid orphans on spawn; cross-install zombies still need a reboot.
- mobile/TESTING.md accumulates all environment quirks (NixOS PATH, corepack pnpm, run-as caveats, hard-link EPERM, etc.) — keep it current when you learn something new.

## Ground rules

- Don't commit anything without the user's say-so. If you instrument code, mark it clearly as temporary.
- After root-causing, prefer the minimal fix; decide whether it belongs in repo source (`packages/`, `apps/`) or the mobile packaging layer (`mobile/`).
- Repo gates: `corepack pnpm --config.verify-deps-before-run=false run <gate>` (knip/constraints/translation-pairing matter if you touch docs).
