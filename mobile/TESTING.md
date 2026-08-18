# Testing the Android app — process notes

Notes for whoever (or whichever agent) iterates on `mobile/`: how the pieces were verified here, and the environment quirks that cost time. Updated as the workflow runs.

## Environment quirks (this machine: NixOS, no Android toolchain)

- **pnpm is not on PATH** — use `corepack pnpm` (repo pins pnpm 11.7.0 via `packageManager`).
- **`pnpm run` in a non-TTY aborts** with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` when it decides node_modules is stale. Bypass for read-only gates (no install, no mutation): `corepack pnpm --config.verify-deps-before-run=false run <gate>`. Do NOT blanket-`CI=true`: that flips installs to `--frozen-lockfile`, which is exactly wrong while you're adding workspace deps; use `CI=true corepack pnpm install --no-frozen-lockfile` in that phase, then a final `CI=true corepack pnpm install --frozen-lockfile` to prove the committed lockfile is consistent.
- **Node is at `/run/current-system/sw/bin/node`**, not `/usr/bin`. Any `env -i` smoke test must put that (and `/usr/bin:/bin` for `ar`/`tar`/`readelf`) on PATH, or you get a confusing `env: 'node': No such file or directory`.
- **No JDK and no Android SDK locally**, so the Java/Kotlin side and `assembleDebug` are compile-untested by design; `.github/workflows/android-build.yml` owns that signal. The Java was static-reviewed against the Capacitor 6 sources in `mobile/node_modules/@capacitor/android/capacitor/src/main/java/`. `nix-shell` gets you a JDK but Android SDK tools are FHS binaries — expect pain on NixOS; CI is the path of least resistance.
- **Bash tool calls run in a fresh shell each time**: `kill %1`, exported vars, and `cd` do not persist between invocations. Kill smoke processes by pattern (`pkill -f <unique-substring>`), and re-`cd`/re-export in every call. Background `nohup ... &` survives the call; that's the way to keep the test host alive while you `curl` it in a later call.
- oxlint already ignores `**/*.js` and `**/*.mjs`, so `mobile/scripts/*.mjs` needs no lint config; knip needed `mobile/deploy-root` in `ignoreWorkspaces` (same treatment as the Python SDK's deploy root) and `cap`/`which` in `ignoreBinaries`.

## Verifying the runtime closure (the high-value smoke test)

The deployed closure can be booted on plain Linux — do this before touching the APK:

```sh
rm -rf /tmp/dsh-mobile-smoke && mkdir -p /tmp/dsh-mobile-smoke/{home,dsh,work}
cd /tmp/dsh-mobile-smoke/work
env -i HOME=/tmp/dsh-mobile-smoke/home TMPDIR=/tmp DSH_HOME=/tmp/dsh-mobile-smoke/dsh \
  DSH_TELEMETRY_DISABLED=1 PATH=/run/current-system/sw/bin:/usr/bin:/bin \
  nohup node --expose-internals \
  /home/bepis/prog/deepseek-harness-mobile/mobile/runtime/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --patch /home/bepis/prog/deepseek-harness-mobile/mobile/runtime/deploy/mobile.cordis.patch.yml \
  --port 0 > boot.log 2>&1 &
```

Then poll for the readiness line and probe the server in **later** Bash calls:

```sh
grep "dsh web:" /tmp/dsh-mobile-smoke/work/boot.log      # readiness: dsh web: http://127.0.0.1:<port>
curl -s http://127.0.0.1:<port>/ | grep -c __DSH_BOOT__  # 1 = boot manifest injected
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/sessions   # 200 = SPA fallback
pkill -f "expose-internals /home/bepis/prog/deepseek-harness-mobile"        # cleanup
```

Three bugs this caught that you may hit again:

1. **`--expose-internals` is mandatory.** Without it, `fromInternal()` (vendor/loader/src/internal.ts) falls back to the `node-addon-require-builtin` native module and every profile plugin fails with `Cannot find package ... imported from vendor/loader/lib/index.js` — the error blames the loader file, not the resolution parent, which is misleading.
2. **Launcher flags end at the first unknown token.** `--patch` must come *before* `--port 0`; after `--port` everything passes through to the web app, which rejects `--patch` (`error: unknown option '--patch'`).
3. **`Error: dsh: N entries did not activate / <row>: pending (waiting for service: X)` after the readiness line is a boot failure, not success.** The `dsh web:` line prints on settlement; `assertEntriesActivated` then throws over pending rows. In the first iterations bash-sandbox + permission-presets pended because the patch overlay disabled `subprocess`; the fix was stubbing node-pty in the deployed closure (see `scripts/package-runtime.mjs`) instead of disabling the row.

### Missing-module whack-a-mole

`pnpm deploy --legacy --prod --config.auto-install-peers=false` ships no implicit peers, so the first boots die with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-...'`. The loop: run the smoke command, grep the missing name, add it as `"workspace:^"` to `deploy-root/package.json`, `CI=true corepack pnpm install --no-frozen-lockfile`, re-run `node mobile/scripts/package-runtime.mjs`, repeat. The settled list is committed in that manifest; extend it the same way if the composition grows.

## Verifying the Termux Node fetch

`node mobile/scripts/fetch-termux-node.mjs` needs `ar`, `tar`, `readelf`, `find` plus network to `packages-cf.termux.dev`. It pins everything into `runtime/termux.lock.json` and fails the build if any `DT_NEEDED` of any extracted ELF is unresolved. `--refresh` re-pins against current Termux packages. The rootfs keeps only `usr/bin/node` + `usr/lib` (~95 MB).

Extracted tarballs use GNU long-name (`L`), long-link (`K`), hard-link (`1`) and symlink (`2`) members — any extractor (including the Java one in `NodeRuntime.untar`) must handle all four; the `runtime.tgz` from `scripts/package-runtime.mjs` contains thousands of each.

## On-device probing (first device contact, 2026-08-18)

With the phone on USB: `cd dev && nix-shell --run "adb ..."` (dev shell has adb; device was a Pixel-class arm64).

- Crash loop reproduced via monkey + `adb logcat -d -b main -b crash`: `NodeRunnerService` died with `SecurityException: ... has android.permission.WAKE_LOCK` — the manifest was missing `WAKE_LOCK`; fixed in the same commit as this note. Lesson: static review can verify API *signatures* but not permission coverage; the manifest's permission list must be cross-checked against every API the Java calls (`PowerManager.newWakeLock` → `WAKE_LOCK`).
- Termux node pushed to `/data/local/tmp` (adb push can't create symlinks — push a dereferenced copy, `cp -rL`) and run with `LD_LIBRARY_PATH=<dir>/lib`: **v26.4.0 executes, `process.platform === "android"`, node:sqlite round-trips, worker_threads present**.
- **Symlinks on shared storage fail with EACCES** even from the shell user; raw writes work. The launcher probe is therefore expected to resolve `DSH_HOME` to app-private storage on stock devices, with the picked folder as the workspace — validated the design against reality.

- Second device contact (same day): runtime extraction died with `link failed for …/libicuio.so.78` mid-archive. Root causes, both reproduced as the app user via `run-as dev.phylliida.dsh`:
  - **Hard links are EPERM in app-private storage** (SELinux; symlinks are fine). The runtime tarball carries thousands of `hrw` ('1') members because pnpm links store files by hard link, so extraction was guaranteed to abort at the first one. Fix: `tar --hard-dereference` when packing `runtime.tgz`.
  - **Interrupted extraction + retry = EEXIST on symlink/link entries.** `ensureExtracted` re-runs after any abort, and the old state wasn't guaranteed gone. Fix: delete-before-create on '1'/'2' entries in `NodeRuntime.untar`.
  - Diagnostic repair: the failure handler only surfaced `IOException`'s own message, hiding the `ErrnoException` errno; it now chains causes into both the launcher log and `adb logcat` (tag `dsh-node`). Read device state with `run-as dev.phylliida.dsh ls files/runtime/…`; the APK on this machine (`dev/DSH.apk`) contains the exact `assets/runtime.tgz` running on-device — inspect entries with `tar -tvf <(zcat assets/runtime.tgz)`.

## What is NOT covered locally

- Gradle/APK compilation and Java compilation: CI only.
- Anything on-device: SELinux exec of the extracted `bin/node` (targetSdk 28 assumption), Termux binary compat, storage-permission flow, phantom-process behavior, WebView navigation to the announced port. First contact checklist for a device install is effectively: launcher shows status → pick folder → node starts → readiness line → WebView jumps into the full UI → run a tiny task that uses the fs tools (bash will fail loudly by design).
- Repo test suites were not re-run: this change adds no source behavior to `packages/` or `apps/`; the gates that own the new surface are knip, constraints, translation-pairing, agent-note gates, `npx cap sync android`, plus the smoke test above.
