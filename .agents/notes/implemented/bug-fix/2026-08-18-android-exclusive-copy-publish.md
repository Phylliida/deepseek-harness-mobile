# Agent Note: Android exclusive-copy no-replace publication

Status: implemented

English | [中文](2026-08-18-android-exclusive-copy-publish.zh.md)

## Problem

Three durability boundaries publish a fully written, fsynced staging file to its final name with `link()`, chosen over `rename()` because `link()` fails EEXIST on collision — two writers can never clobber each other: `dsh-session-persistence-jsonl` materializing a session log (see the [Windows durable-publish decision](../architecture/2026-07-05-windows-jsonl-durable-publish.md)), `dsh-attachment-local` publishing a content-addressed object, and `dsh-fs-local`'s `createIfAbsent` guarded write (see the [absence-observation decision](../bug-fix/2026-08-09-filesystem-absence-observation.md)).

Android storage has no usable hard links: SELinux denies `link()` in app-private storage for untrusted apps, and sdcardfs (shared storage, the agent workspace) does not support them at all. Every one of these writes failed EACCES/EPERM on device — the observed symptom was the first chat turn failing with `EACCES: permission denied, link '…session.jsonl.zstd.….tmp' -> '…session.jsonl.zstd'`. Symlinks are a related asymmetry: they work in app-private storage but fail EACCES on shared storage.

## Decision

Each site keeps its staging write and its EEXIST no-clobber contract, but dispatches on `process.platform === 'android'` to publish with `copyFile(tmp, target, COPYFILE_EXCL)` — an exclusive copy that fails EEXIST exactly like `link()`, feeding the same collision mappings (`rejectExistingLog`, dedup-verify, `FS_NOT_OBSERVED`). The copy is fsynced (and in `fs-local` chmodded to the temp's 0o600) before the caller's directory syncs run, so the published content meets the same durability bar as the linked inode.

The accepted trade-off: a crash between the exclusive create and the copy completing can leave the final path present with partial content, where `link()` publishes complete content atomically. No no-replace rename primitive (renameat2 `RENAME_NOREPLACE`) is reachable from Node. For the attachment store, a torn object fails integrity verification loudly on the next store of the same hash rather than silently deduping.

`fs-local`'s arm is pinned in unit tests through the existing `internals.platform` / `internals.copyFileExclusive` seams; the other two arms carry v8 ignores mirroring the Windows precedent, because coverage hosts never run Android.

## Alternatives considered

**Detect link failure at runtime and fall back.** Rejected: platform dispatch matches the existing win32 precedent, keeps the failure surface deterministic, and avoids conflating a genuine EEXIST collision with missing hard-link support — the ambiguity `fs-local`'s guarded failure mapping already has to inspect around.

**Symlink as the no-clobber guard.** Rejected: symlink creation also fails EEXIST, but a symlinked session log would be invisible to the backend's own `readdir` listing (`Dirent.isFile()` excludes symlinks) and symlinks are denied outright on shared storage.

**One shared helper in `dsh-atomic-write`.** Rejected for now: each site owns a different durability dance (directory fsync ordering, dedup verification, DACL handling), the shared core is ten lines, and new cross-package dependency edges cost more than the duplication.

## Consequences

Sessions materialize, attachments store, and guarded file creation work on Android; first-turn EACCES is gone (verified on device through the repackaged closure). Non-Android behavior is byte-identical — the link arm is untouched and remains the covered path on every CI host. The Android arms trade a small crash-atomicity window for platform reach, documented at each site.
