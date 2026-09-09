import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'

/**
 * Keyless backend integration through `confine()` and a real bwrap process. With no rung forced,
 * a passing probe must select the first rung. Tests assert world effects, wrap shape, and that the
 * kernel denial matches the advertised dialect; consumer coverage lives in dsh-bash-sandbox.
 * Skips when bwrap or user namespaces are unavailable. Fresh per-test workspace directories
 * keep each assertion independent, so workspace-write actually proves the workspace-root rebind.
 */

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

/** unshare(1) needs user namespaces too; a harness run may itself be wrapped. */
const unshareUsable = spawnSync('unshare', ['--mount', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

let ctx: Context | undefined
const tempDirs: string[] = []
const tempFiles: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-bwrap-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(config: Config = {}): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  return ctx.sandbox as LocalSandboxProvider
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, confined }
}

/** Quote one argv element for re-assembly into a shell string. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", String.raw`'\''`)}'`
}

/**
 * Run a shell `command` in a scratch child mount namespace where /tmp is a
 * PRIVATE tmpfs: host /tmp is the shared world-writable cauldron (another
 * process could place anything there mid-run), so a private, empty tmpfs is
 * the only scratch area guaranteed to stay outside every one of the wrap's
 * grants. unshare(1) builds the namespace without privilege; the tmpfs dies
 * with the child.
 */
function runInPrivateTmpfs(command: string) {
  return spawnSync('unshare', ['--mount', 'sh', '-c', `mount --make-rprivate / && mount -t tmpfs tmpfs /tmp && ${command}`], { timeout: 30_000, encoding: 'utf8' })
}

describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap confinement', () => {
  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const confined = sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.argv[0]).toBe('bwrap')
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
  })

  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and the fresh /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it.skipIf(!unshareUsable)('workspace-write lands a write inside the workspace root and still denies one outside it', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()

    const inside = runConfined(sandbox, `printf bwrap-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('bwrap-ok')

    // /tmp is writable under workspace-write, so the denied target lives in a
    // child mount namespace whose /tmp is a private tmpfs: that tree is real
    // on disk but outside every grant of the wrap, so the confined write can
    // only fail with the wrap's own read-only denial.
    const scratch = `/tmp/dsh-bwrap-e2e-outside-${process.pid}`
    const confined = sandbox.confine(['bash', '-c', `echo hi > ${scratch}/denied.txt`], { mode: 'workspace-write', workspaceRoot: workdir })
    const denied = runInPrivateTmpfs(`mkdir -p ${scratch} && ${confined.argv.map(shellQuote).join(' ')}`)
    expect(denied.status).not.toBe(0)
    expect(denied.stderr.toLowerCase()).toContain('read-only file system')
  })

  it('workspace-write grants the host /tmp: the write lands on the host temp area and outlives the command', async () => {
    // Temp parity across the runners: a confined command's /tmp write is a
    // HOST file, so a later command or session can reopen the same path.
    const workdir = await tempDir(tmpdir())
    const target = `/tmp/dsh-bwrap-e2e-persistent-${process.pid}.txt`
    tempFiles.push(target)
    const sandbox = await provider()
    const { result } = runConfined(sandbox, `printf tmp-ok > ${target}`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('tmp-ok')
  })
})

/** `/dev/dri` marks a GPU host; bwrap's minimal `/dev` never carries it, so its presence inside a wrap proves the passthrough. */
const driPresent = existsSync('/dev/dri')

describe.skipIf(!bwrapUsable || !driPresent)('sandbox-local: device passthrough through real bwrap', () => {
  it('a configured device directory appears inside the wrap', async () => {
    const workdir = await tempDir(tmpdir())
    const granted = await provider({ devicePassthrough: ['/dev/dri'] })
    const inside = runConfined(granted, 'ls /dev/dri', { mode: 'read-only', workspaceRoot: workdir })
    expect(inside.confined.argv).toContain('--dev-bind')
    expect(inside.result.status).toBe(0)
    expect(inside.result.stdout).toMatch(/^(card\d|renderD\d+)$/m)
  })

  it('without the grant the same directory stays hidden', async () => {
    const workdir = await tempDir(tmpdir())
    const plain = await provider()
    const outside = runConfined(plain, 'ls /dev/dri', { mode: 'read-only', workspaceRoot: workdir })
    expect(outside.result.status).not.toBe(0)
  })
})
