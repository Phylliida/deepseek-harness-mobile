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

## What is NOT covered locally

- Gradle/APK compilation and Java compilation: CI only.
- Anything on-device: SELinux exec of the extracted `bin/node` (targetSdk 28 assumption), Termux binary compat, storage-permission flow, phantom-process behavior, WebView navigation to the announced port. First contact checklist for a device install is effectively: launcher shows status → pick folder → node starts → readiness line → WebView jumps into the full UI → run a tiny task that uses the fs tools (bash will fail loudly by design).
- Repo test suites were not re-run: this change adds no source behavior to `packages/` or `apps/`; the gates that own the new surface are knip, constraints, translation-pairing, agent-note gates, `npx cap sync android`, plus the smoke test above.
