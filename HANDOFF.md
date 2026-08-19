# HANDOFF — deepseek-harness-mobile state (2026-08-18, second session)

Supersedes the previous HANDOFF.md (committed as eba7429). Read this before anything else.

## What this repo is

Fork of DeepSeek Harness (plugin-based agent harness on vendored Cordis, pnpm monorepo) packaged as a **self-contained Android app** in `mobile/`: Capacitor 6 shell (appId `dev.phylliida.dsh`, targetSdk 28, debug-signed with committed keystore) + Java `NodeRunnerService` extracting `assets/runtime.tgz` (Termux Node 26 + pnpm-deployed web-host closure) into `files/runtime/` and spawning `node --expose-internals <deploy>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --patch <deploy>/mobile.cordis.patch.yml --port 0`. The launcher page (`mobile/www/index.html`) polls `DshMobile.getState()` and navigates to the announced loopback port.

Folder model: user picks a shared-storage folder = agent workspace (node cwd). `DSH_HOME` = app-private `files/dsh` (symlink probe keeps it off sdcardfs — the profile module fallback `boot/app-boot/src/profile.ts` creates symlinks under `$DSH_HOME/profiles/node_modules`). Settings/credentials/sessions live in `files/dsh`, not the picked folder.

CI: `.github/workflows/android-build.yml` builds the debug APK — **trigger is `push` to `master` (this repo's branch is `main`) + `workflow_dispatch`; dispatch manually with `gh workflow run android-build.yml` if pushing main doesn't start it.**

## Bugs root-caused and fixed this session (all committed on main)

1. **"signal timed out" on Settings → Models Apply** (0deb4c4): NOT an RPC bug — the browser's 30s `AbortSignal.timeout` (packages/host/apiproxy/src/fetch/client.ts:315) fired because the Chrome tab was pointed at a stale port held by a **wedged zombie host from the previous install** (different uid, unkillable without root). The RPC path itself answers in <0.3s on Linux and on-device. Fix: `NodeRuntime.killStaleHosts` sweeps same-uid `/proc` cmdline matches before spawn. Cross-install zombies still need a phone reboot.
2. **Workspace picker couldn't reach the picked folder** (5818555): the browse dialog opens at app-private HOME and its breadcrumbs cross `/` and `/storage`, both EACCES to the app. Fix: `NodeRuntime.seedWorkspace` POSTs `workspace.create` for the picked folder from Java at readiness (must be Java-side — the host's cross-site write fence requires application/json and never answers CORS preflights, so a fetch from the launcher page's Capacitor origin is never sent).
3. **Picking a workspace bounced back silently** (1217a4f): `session.create` failed `agent-preset-invalid` — the closure was missing runtime peers only session boot imports (`dsh-workflow`, `dsh-compaction`, `dsh-session-telemetry`, `dsh-invariants`), now explicit in `mobile/deploy-root/package.json`. Audit recipe: walk staged `node_modules/*/package.json` peerDependencies vs the installed set. The smoke test after composition growth is boot + `session.create`, not just boot.
4. **First turn failed `EACCES: … link …`** (df8db4a + 625324c): Android has no usable hard links (SELinux denies `link()` app-private; sdcardfs has none). The three `link()` no-clobber publish sites (session-persistence-jsonl, attachment-local, fs-local `createIfAbsent`) dispatch on `process.platform === 'android'` to `copyFile(COPYFILE_EXCL)`. A full link/symlink sweep found no other fs users; `storage-json` uses rename (safe), schemastery's `link` is a schema API. Agent Note: `.agents/notes/implemented/bug-fix/2026-08-18-android-exclusive-copy-publish.md`.

Also fixed: `package-runtime.mjs` stubbing poisoned workspace `node_modules` (pnpm deploy hard-links store files into staging; in-place writes truncated the shared inode). Now delete-before-write.

## Current device / deploy state

- Phone: Pixel-class, Android 15, serial `39191FDJH00HME`, app uid currently u0_a301 (was reinstalled; uid changes per install). adb via `cd dev && nix-shell --run "adb -s 39191FDJH00HME …"`.
- Device runs APK versionName 1.0. Commits through 625324c bump to **1.1**; `NodeRuntime.ensureExtracted` keys its marker on versionName, so the 1.1 install re-extracts the fixed runtime. **Any future runtime.tgz change MUST bump versionName** (comment in build.gradle).
- The live host already has `/storage/emulated/0/DSH` registered as Workspace "DSH" (seeded via curl; durable in `files/dsh`). A stray "Beed" workspace points into app-private home (created by the picker trap) — delete from the sidebar.
- Verified working on-device: extraction, boot, UI, settings/credentials writes (kimi-coding key saved), workspace create/list, direct writes to `/storage/emulated/0/DSH` from the real node process. NOT yet verified: a full chat turn end-to-end (needs the 1.1 redeploy for the hard-link fix; LLM DNS may be the next failure — see below).

## Operational knowledge (cost time; don't relearn)

- **run-as children lack inet gid 3003** → network probes via run-as are artifacts (UDP EPERM / TCP ETIMEDOUT). The real app node HAS it. run-as also lacks the app's /sdcard mount namespace → raw-path denies via run-as are artifacts.
- **Finding the live port**: `cat /proc/net/tcp /proc/net/tcp6 | awk '$4=="0A"'` (tcp6 has v4-mapped rows!), then map inode→pid via `run-as dev.phylliida.dsh ls -l /proc/<node-pid>/fd | grep socket`. The app node owns exactly one LISTEN socket. Don't trust a port without the PID check — zombies hold stale ports. Chrome devtools (`adb forward tcp:9222 localabstract:chrome_devtools_remote`, GET /json) reveals which port a stale browser tab is on.
- **`/proc/<pid>/cmdline` truncation lies**: a `head -c 300` read made a wedged full dsh host look like a `node -e` probe. Dump the whole cmdline.
- **Manual runtime swaps need the marker**: `files/runtime/.extracted-<versionName>` — swap without recreating the marker and the app wipes your swap and re-extracts the APK's tgz.
- **RPC probe recipe**: `POST /api/<method>` with `{"type":"client-request","rpcId":<uuid>,"method":<m>,"payload":{...}}`, content-type application/json. Methods used: settings.describe/mutate, credentials.set, workspace.create/list, session.create, host.listDirectory, host.createDirectory. Browser unary calls carry a 30s AbortSignal.timeout — "signal timed out" = host never answered.
- Linux smoke of the exact phone closure: boot `mobile/runtime/deploy/.../bin.js` with `env -i` (node at `/run/current-system/sw/bin`); full recipe in mobile/TESTING.md. Never `pkill -f` with a pattern that matches your own shell command line.

## Known loose ends (next work, ranked)

1. **Full-turn verification after 1.1 redeploy.** If the turn fails DNS (ENOTFOUND/ECONNREFUSED from c-ares): wire `--require <deploy>/android-preload.cjs` into the NodeRuntime spawn AND add the file in package-runtime.mjs (preload exists in the design; not yet packaged/passed). run-as DNS probes are artifacts — only the real app process tells the truth.
2. **UI swallows session.create errors** (pick bounced with no message while the host returned a precise `agent-preset-invalid`). Gap in ui-workspace's adopt flow; worth an upstream issue/PR.
3. **Local workspace node_modules repair**: sharp (`dist/sharp.mjs`) and node-pty (`lib/index.js`) in `.pnpm` still carry Android stubs from the pre-fix packaging script; restore from npm tarballs (`curl registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz`) when local attachment tests matter again.
4. `dev/DSH.apk` (95MB) and `dev/.direnv/` are untracked on purpose — consider .gitignore entries.
5. Only `primary:` volumes can be picked (decodeTreePath); SD cards need an SAF/DocumentFile bridge that node can't use for raw paths. memki (`ref/memki`) is the SAF reference; its write pattern (tmp+rename) is already matched by dsh-atomic-write/fsio.

## Ground rules

- Don't commit without the user's say-so (they sometimes commit themselves; check `git log` before assuming a diff is uncommitted). Never `git push` for them.
- Repo gates: `corepack pnpm --config.verify-deps-before-run=false run <gate>`. attachment-local tests fail locally until the sharp stub is repaired (pre-existing, environmental).
- Non-trivial changes need an Agent Note triplet (en/zh/i18n.yaml via `verify-translation-pairing --write`); format gate: `verify-agent-note-format`. Notes in `.agents/notes/`, rules in `.agents/notes/README.md`.
- Keep mobile/TESTING.md current when you learn something new.
