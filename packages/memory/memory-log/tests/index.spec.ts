/** LogMemory provider construction: Config defaults, directory resolution, and the run() pass-through. */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LogMemory from '../src/index.ts'

let dir: string
let ctx: Context

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-provider-'))
  ctx = new Context()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('LogMemory', () => {
  it('creates its store at load and answers the OptMem dialogue through run()', async () => {
    await ctx.plugin(LogMemory, { directory: join(dir, 'mem') })
    expect(existsSync(join(dir, 'mem', 'LOG.txt'))).toBe(true)
    await expect(ctx.memory.run('wake')).resolves.toBe(
      'No memories yet. Record the first with: note "<one line>"\nYou are awake.',
    )
    await expect(ctx.memory.run('note "created at load"')).resolves.toBe('Saved as #0.')
  })

  it('exposes the resolved store directory and expands ~ in config', async () => {
    const rel = join(dir, 'tilde-target')
    await ctx.plugin(LogMemory, { directory: rel })
    expect(ctx.memory).toBeInstanceOf(LogMemory)
    const provider = ctx.memory as LogMemory
    expect(provider.directory).toBe(resolve(rel))
  })

  it('honors an explicit full sizes Config', async () => {
    await ctx.plugin(LogMemory, {
      directory: join(dir, 'mem'),
      wakeLines: 2, entryChars: 200, partChars: 10_000, partLines: 400,
    })
    await ctx.memory.run('note "a"')
    await ctx.memory.run('note "b"')
    await ctx.memory.run('note "c"')
    // wakeLines 2 makes three memories exceed the context: the block summary
    // is needed, so wake refuses and asks for the nap — proof the sizes took.
    const woken = await ctx.memory.run('wake')
    expect(woken).toContain('Cannot wake: the memory context needs #0-1')
    expect(woken).toContain('Run: nap 0-1 "<your line>"')
  })

  it('falls back to $DSH_HOME/memory when no directory is configured', async () => {
    const home = join(dir, 'home')
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await ctx.plugin(LogMemory, {})
      expect((ctx.memory as LogMemory).directory).toBe(resolve(join(home, 'memory')))
      expect(existsSync(join(home, 'memory', 'LOG.txt'))).toBe(true)
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME')
      else process.env.DSH_HOME = prev
    }
  })

  it('rejects an entryChars beyond the 280-byte record capacity at load', async () => {
    await expect(ctx.plugin(LogMemory, { directory: join(dir, 'mem'), entryChars: 281 }))
      .rejects.toThrow()
  })

  it('defaults every size outside the schema path (direct construction)', async () => {
    // Cordis always runs the schema, but the class is constructible without
    // it; the coalesce is the defense, and this test covers it.
    const bare = new LogMemory(ctx, { directory: join(dir, 'bare'), projectsRoot: dir })
    const woken = await bare.run('wake')
    expect(woken).toContain('You are awake.')
  })

  it('routes projects/use to project stores; every other command targets the active store', async () => {
    mkdirSync(join(dir, 'root', 'alpha'), { recursive: true })
    mkdirSync(join(dir, 'root', 'beta', 'nested'), { recursive: true })
    mkdirSync(join(dir, 'root', '.hidden'))
    await ctx.plugin(LogMemory, { directory: join(dir, 'mem'), projectsRoot: join(dir, 'root') })

    // projects lists immediate child directories, never dot-dirs or leaves
    const listed = await ctx.memory.run('projects')
    expect(listed).toBe(`Projects under ${join(dir, 'root')}:\n  alpha\n  beta\nActive memory: global\nSelect a project: use <name>   Global memory: use global`)

    // usage errors
    await expect(ctx.memory.run('projects all')).rejects.toThrow('usage: projects')
    await expect(ctx.memory.run('use')).rejects.toThrow('usage: use <project>|global')
    await expect(ctx.memory.run('use alpha extra')).rejects.toThrow('usage: use <project>|global')
    await expect(ctx.memory.run('use gamma')).rejects.toThrow('gamma is not a project under')
    await expect(ctx.memory.run('use ../etc')).rejects.toThrow('is not a project under')

    // select alpha: the store is physically created inside the project
    await expect(ctx.memory.run('use alpha'))
      .resolves.toBe('Switched to alpha, whose memory lives in its .memory/ directory. Run: wake')
    expect(existsSync(join(dir, 'root', 'alpha', '.memory', 'LOG.txt'))).toBe(true)
    expect((ctx.memory as LogMemory).scope).toBe('alpha')

    // notes land in the active store only
    await ctx.memory.run('note "alpha decision"')
    await ctx.memory.run('use beta')
    await ctx.memory.run('note "beta decision"')
    await expect(ctx.memory.run('recall alpha')).resolves.toBe('No match.')
    await ctx.memory.run('use global')
    await expect(ctx.memory.run('recall alpha')).resolves.toBe('No match.')
    await ctx.memory.run('use alpha')
    await expect(ctx.memory.run('recall alpha'))
      .resolves.toMatch(/alpha decision/)

    // the listing now marks both stores
    expect(await ctx.memory.run('projects'))
      .toContain('  alpha (active, has memory)')
    expect(await ctx.memory.run('projects'))
      .toContain('  beta (has memory)')
    await ctx.memory.run('use global')
    expect((ctx.memory as LogMemory).scope).toBeNull()
    expect(await ctx.memory.run('wake')).toContain('You are awake.')
  })

  it('reports no projects under an empty root', async () => {
    mkdirSync(join(dir, 'empty'))
    await ctx.plugin(LogMemory, { directory: join(dir, 'mem'), projectsRoot: join(dir, 'empty') })
    await expect(ctx.memory.run('projects')).resolves.toBe(
      `No project directories under ${join(dir, 'empty')}.\nActive memory: global\nSelect a project: use <name>   Global memory: use global`,
    )
  })

  it('honors a custom projectsDir name', async () => {
    mkdirSync(join(dir, 'root', 'alpha'), { recursive: true })
    await ctx.plugin(LogMemory, {
      directory: join(dir, 'mem'), projectsRoot: join(dir, 'root'), projectsDir: 'memory-store',
    })
    await ctx.memory.run('use alpha')
    expect(existsSync(join(dir, 'root', 'alpha', 'memory-store', 'LOG.txt'))).toBe(true)
    await expect(ctx.memory.run('use alpha'))
      .resolves.toBe('Switched to alpha, whose memory lives in its memory-store/ directory. Run: wake')
  })

  it('fails loud at load for a nonexistent explicitly configured projectsRoot', async () => {
    await expect(ctx.plugin(LogMemory, {
      directory: join(dir, 'mem'), projectsRoot: join(dir, 'no-such-root'),
    })).rejects.toThrow('projectsRoot')
  })

  it('fails loud at load for a projectsDir that is not one directory name', async () => {
    for (const bad of ['.', '..', 'a/b', 'a\\b']) {
      await expect(ctx.plugin(LogMemory, {
        directory: join(dir, 'mem'), projectsRoot: dir, projectsDir: bad,
      })).rejects.toThrow('projectsDir must be one directory name')
    }
  })

  it('scopes the default-cwd projectsRoot and expands ~', async () => {
    // Direct construction without projectsRoot: process.cwd() becomes the
    // root (the other coalesce side of projectsRoot).
    mkdirSync(join(process.cwd(), 'tmp-memory-cwd-probe'), { recursive: true })
    try {
      const bare = new LogMemory(ctx, { directory: join(dir, 'bare') })
      expect(await bare.run('projects')).toContain('tmp-memory-cwd-probe')
    } finally {
      rmSync(join(process.cwd(), 'tmp-memory-cwd-probe'), { recursive: true, force: true })
    }
  })
})
