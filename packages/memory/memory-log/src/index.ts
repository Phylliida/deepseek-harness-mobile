/**
 * Append-only-log memory provider (`ctx.memory`): the
 * [OptMem](https://github.com/VictorTaelin/OptMem) design as a harness
 * service, byte-compatible with the upstream store. One fixed-width
 * append-only `LOG.txt` holds every memory; a binary summary tree under
 * `TREE/` is a rebuildable cache the agent itself compresses, one block at a
 * time, through nap answers. Detail decays with age: wake renders recent
 * memories verbatim and ancient ones as one-line summaries, within a
 * configurable line budget. The store directory is created at load —
 * pointing `directory` at a store IS the deliberate act of opening that
 * identity.
 *
 * On top of the global store, two routing commands give the one agent a
 * memory per project: `projects` lists the immediate child directories of
 * `projectsRoot`, and `use <name>` switches the active store into the
 * `projectsDir` inside that directory (`use global` switches back). Every
 * other command goes to the active store unchanged, so the dialogue inside
 * each store stays byte-for-byte OptMem.
 * @module @deepseek-ai/dsh-memory-log
 */

import { existsSync, readdirSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { MemoryError, MemoryService } from '@deepseek-ai/dsh-memory'
import { join, resolve } from 'node:path'
import type { MemorySizes } from './store.ts'
import { DEFAULT_SIZES, ENTRY_CHARS_MAX, MemoryStore } from './store.ts'
import { runCommand, splitArgs } from './engine.ts'

export { DEFAULT_SIZES, ENTRY_CHARS_MAX, LOG_REC, MemoryStore, RAW_MAX, TREE_REC } from './store.ts'
export type { Block, LogEntry, MemorySizes } from './store.ts'
export { cover, parseBlockId } from './store.ts'
export { nextNap, runCommand, splitArgs, USAGE } from './engine.ts'
export { MemoryError }

/**
 * Deployment configuration for the log memory provider. The sizes are
 * reading and transport budgets, never storage: changing one never
 * recomputes or touches a recorded memory.
 */
export interface Config {
  /**
   * Store directory of the global memory. Defaults to `memory/` under the
   * resolved harness home (`$DSH_HOME`, else `~/.dsh`). A leading `~` is
   * expanded.
   */
  directory?: string
  /**
   * Root whose immediate child directories count as projects for
   * `projects`/`use`. Defaults to the process working directory. A leading
   * `~` is expanded; an explicitly configured root that does not exist fails
   * at load.
   */
  projectsRoot?: string
  /**
   * Store directory created inside a selected project. One directory name,
   * no separators. Defaults to `.memory`.
   */
  projectsDir?: string
  /** How many lines one wake renders (96 ≈ 8k tokens of dense text). Defaults to 96. */
  wakeLines?: number
  /** Longest one memory or summary line, in UTF-8 bytes. Defaults to 280. */
  entryChars?: number
  /** Largest one output part, in UTF-8 bytes (harness truncation headroom). Defaults to 20000. */
  partChars?: number
  /** Largest one output part, in lines. Defaults to 500. */
  partLines?: number
}

/** Schemastery configuration for the log memory provider. */
export const Config: z<Config> = z.object({
  directory: z.string(),
  projectsRoot: z.string().min(1),
  projectsDir: z.string().min(1).default('.memory'),
  wakeLines: z.number().step(1).min(1).default(DEFAULT_SIZES.wakeLines),
  entryChars: z.number().step(1).min(1).max(ENTRY_CHARS_MAX).default(DEFAULT_SIZES.entryChars),
  partChars: z.number().step(1).min(1).default(DEFAULT_SIZES.partChars),
  partLines: z.number().step(1).min(1).default(DEFAULT_SIZES.partLines),
})

/**
 * Resolve deployment configuration into the store's values: the default
 * directory, and the upstream-measured sizes for any field left unset
 * (cordis always fills them through the schema; direct construction may not).
 * @param config - the deployment configuration.
 * @returns the absolute directory/roots and the resolved size budgets.
 */
function resolveConfig(config: Config): {
  directory: string
  projectsRoot: string
  projectsDir: string
  sizes: MemorySizes
} {
  const projectsRoot = resolve(expandHomePath(config.projectsRoot ?? process.cwd()))
  if (config.projectsRoot !== undefined && !existsSync(projectsRoot)) {
    throw new MemoryError(`projectsRoot ${projectsRoot} does not exist.`)
  }
  const projectsDir = config.projectsDir ?? '.memory'
  if (projectsDir === '.' || projectsDir === '..' || projectsDir.includes('/') || projectsDir.includes('\\')) {
    throw new MemoryError(`projectsDir must be one directory name, got ${projectsDir}.`)
  }
  return {
    directory: resolve(expandHomePath(config.directory ?? dshHomePath('memory'))),
    projectsRoot,
    projectsDir,
    sizes: {
      wakeLines: config.wakeLines ?? DEFAULT_SIZES.wakeLines,
      entryChars: config.entryChars ?? DEFAULT_SIZES.entryChars,
      partChars: config.partChars ?? DEFAULT_SIZES.partChars,
      partLines: config.partLines ?? DEFAULT_SIZES.partLines,
    },
  }
}

/**
 * The log memory provider. All operations are synchronous file I/O behind one
 * async seam method: records are fixed-width seeks, never scans, so the event
 * loop cost is one `read` per rendered line.
 *
 * Two routing commands wrap the OptMem dialogue:
 * - `projects` — the immediate child directories of `projectsRoot`, marked
 *   with which holds a store and which is active.
 * - `use <name>` / `use global` — switch the active store. A project store is
 *   created on first selection.
 *
 * Selection is process-wide state of this service instance.
 */
export default class LogMemory extends MemoryService {
  static Config: z<Config> = Config

  private readonly store: MemoryStore
  private readonly sizes: MemorySizes
  private readonly projectsRoot: string
  private readonly projectsDir: string
  private readonly scoped = new Map<string, MemoryStore>()
  private active: string | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = resolveConfig(config)
    this.sizes = resolved.sizes
    this.projectsRoot = resolved.projectsRoot
    this.projectsDir = resolved.projectsDir
    this.store = new MemoryStore(resolved.directory, this.sizes)
    this.store.init()
  }

  /** The resolved global store directory, for diagnostics and tests. */
  get directory(): string {
    return this.store.dir
  }

  /** The active store's project name, or null on the global memory. */
  get scope(): string | null {
    return this.active
  }

  /**
   * Immediate child directory names of projectsRoot, sorted: the projects
   * one `use` may select. Dot-directories and node_modules are never
   * projects.
   * @returns the project names.
   */
  private projectNames(): string[] {
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .sort()
  }

  /**
   * The active store: the global memory by default which costs nothing, or
   * the selected project's, created on first selection and cached after.
   * @returns the store commands read and write.
   */
  private activeStore(): MemoryStore {
    if (this.active === null) return this.store
    let store = this.scoped.get(this.active)
    if (!store) {
      store = new MemoryStore(join(this.projectsRoot, this.active, this.projectsDir), this.sizes)
      store.init()
      this.scoped.set(this.active, store)
    }
    return store
  }

  run(command: string): Promise<string> {
    const [verb, ...args] = splitArgs(command)
    if (verb === 'projects') return Promise.resolve().then(() => this.listProjects(args))
    if (verb === 'use') return Promise.resolve().then(() => this.select(args))
    return runCommand(this.activeStore(), command)
  }

  /**
   * List the projects and which memory is active.
   * @param args - must be empty; extra arguments are a usage error.
   * @returns the listing and the switch hint.
   */
  private listProjects(args: string[]): string {
    if (args.length) throw new MemoryError('usage: projects')
    const names = this.projectNames()
    const listing = names.length
      ? `Projects under ${this.projectsRoot}:\n${names.map((name) => {
        const parts: string[] = []
        if (name === this.active) parts.push('active')
        if (existsSync(join(this.projectsRoot, name, this.projectsDir))) parts.push('has memory')
        return `  ${name}${parts.length ? ` (${parts.join(', ')})` : ''}`
      }).join('\n')}`
      : `No project directories under ${this.projectsRoot}.`
    return `${listing}\nActive memory: ${this.active ?? 'global'}\nSelect a project: use <name>   Global memory: use global`
  }

  /**
   * Switch the active store.
   * @param args - one name (`<project>` or `global`); anything else is a usage error.
   * @returns the switch confirmation and the next command, `wake`.
   */
  private select(args: string[]): string {
    const [name, ...extra] = args
    if (name === undefined || extra.length) throw new MemoryError('usage: use <project>|global')
    if (name === 'global') {
      this.active = null
      return 'Switched to the global memory. Run: wake'
    }
    if (!this.projectNames().includes(name)) {
      throw new MemoryError(`${name} is not a project under ${this.projectsRoot}. See: projects`)
    }
    this.active = name
    // A first selection physically creates the project's store: local memory
    // lands in the working directory the moment it becomes usable.
    this.activeStore()
    return `Switched to ${name}, whose memory lives in its ${this.projectsDir}/ directory. Run: wake`
  }
}
