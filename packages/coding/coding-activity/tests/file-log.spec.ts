import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODING_ACTIVITY_MAX_FUTURE_SKEW_MS,
  CodingActivityFileLog,
  CodingActivityRejectedError,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-coding-activity-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(CodingActivityFileLog, { path })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('CodingActivityFileLog', () => {
  it('starts empty over an absent document and folds appends on disk', async () => {
    const dir = await tempDir()
    const path = join(dir, 'nested', 'coding-activity.json')
    const ctx = await boot(path)
    expect(await ctx.codingActivity.read()).toEqual({ revision: 0, spans: [] })
    const view = await ctx.codingActivity.append({ stamps: [60_000, 90_000] })
    expect(view.revision).toBe(1)
    expect(view.spans).toEqual([{ start: 60_000, end: 90_000 }])
    // A reinstantiated provider reads the same document.
    const again = await boot(path)
    expect(await again.codingActivity.read()).toEqual(view)
  })

  it('emits strictly increasing revisions on content-changing appends only', async () => {
    const ctx = await boot(join(await tempDir(), 'coding-activity.json'))
    const revisions: number[] = []
    ctx.on('coding-activity/updated', revision => { revisions.push(revision) })
    await ctx.codingActivity.append({ stamps: [0] })
    expect(revisions).toEqual([1])
    // The same stamp folds into the existing zero-length span: no change.
    const view = await ctx.codingActivity.append({ stamps: [0] })
    expect(view.revision).toBe(1)
    expect(revisions).toEqual([1])
    await ctx.codingActivity.append({ stamps: [30_000] })
    expect(revisions).toEqual([1, 2])
  })

  it('contains a throwing change listener and still resolves the append', async () => {
    const ctx = await boot(join(await tempDir(), 'coding-activity.json'))
    ctx.on('coding-activity/updated', () => { throw new Error('listener boom') })
    await expect(ctx.codingActivity.append({ stamps: [0] })).resolves.toMatchObject({ revision: 1 })
  })

  it('rejects stamps beyond the future-skew window', async () => {
    const ctx = await boot(join(await tempDir(), 'coding-activity.json'))
    const farFuture = Date.now() + CODING_ACTIVITY_MAX_FUTURE_SKEW_MS + 60_000
    await expect(ctx.codingActivity.append({ stamps: [farFuture] }))
      .rejects.toBeInstanceOf(CodingActivityRejectedError)
  })

  it('merges an external write instead of clobbering it', async () => {
    const dir = await tempDir()
    const path = join(dir, 'coding-activity.json')
    const ctx = await boot(path)
    await ctx.codingActivity.append({ stamps: [0] })
    // A second dsh process appended between this one's read and its next append.
    await writeFile(path, JSON.stringify({
      version: 1,
      revision: 7,
      spans: [{ start: 0, end: 0 }, { start: 600_000, end: 660_000 }],
    }))
    const view = await ctx.codingActivity.append({ stamps: [60_000] })
    // The stamp bridges to the {0,0} anchor (60 s < 2 min), extending it.
    expect(view.spans).toEqual([{ start: 0, end: 60_000 }, { start: 600_000, end: 660_000 }])
    expect(view.revision).toBe(8)
  })

  it('fails loud on a document that is not the v1 format', async () => {
    const dir = await tempDir()
    const path = join(dir, 'coding-activity.json')
    await writeFile(path, JSON.stringify({ version: 2, revision: 0, spans: [] }))
    const ctx = await boot(path)
    await expect(ctx.codingActivity.read()).rejects.toThrow('is not a v1 document')
  })

  it('serializes concurrent appends without losing stamps', async () => {
    const ctx = await boot(join(await tempDir(), 'coding-activity.json'))
    const pending = [0, 1, 2, 3, 4].map(index =>
      ctx.codingActivity.append({ stamps: [index * 20 * 60_000] }),
    )
    const views = await Promise.all(pending)
    const last = await ctx.codingActivity.read()
    expect(last.spans).toEqual([0, 1, 2, 3, 4].map(index => ({ start: index * 20 * 60_000, end: index * 20 * 60_000 })))
    // Queued views resolve in order with monotonic revisions.
    for (let index = 1; index < views.length; index++) {
      expect(views[index]!.revision).toBeGreaterThan(views[index - 1]!.revision)
    }
  })
})
