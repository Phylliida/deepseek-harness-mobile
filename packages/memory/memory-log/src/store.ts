/**
 * OptMem-style memory store: fixed-width append-only log plus a rebuildable
 * binary summary tree. Clean-room TypeScript port of the published design
 * (the upstream repo carries no license, so only the algorithms and formats
 * are reproduced, not the code).
 *
 * Layout of the store directory:
 *   LOG.txt    one fixed-width record per memory, append-only, never edited
 *   TREE/<n>   one fixed-width record per size-n block summary, dense prefix
 *   LOG.txt.lock  cross-process writer mutex (wx-created sibling, see
 *   dsh-atomic-write's withFileLock); OptMem's own flock-based .lock file is
 *   left untouched so one store can be shared with the upstream tool.
 *
 * Records are fixed width so position is identity: memory i lives at byte
 * offset i*LOG_REC, block [k*n,(k+1)*n) at k*TREE_REC of TREE/<n>. Padding
 * costs disk and buys O(1) seeks with no index to keep in sync.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync, writeSync } from 'node:fs'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import { join } from 'node:path'

/** Byte length of one LOG.txt record, newline included. */
export const LOG_REC = 320
/** Byte length of one TREE level record, newline included. */
export const TREE_REC = 288
/** Blocks of at most this many memories compress straight from the raw log. */
export const RAW_MAX = 16

/** Tunable sizes of a store. All are reading/transport budgets, never storage. */
export interface MemorySizes {
  /** How many lines one wake renders (96 ≈ 8k tokens of dense text). */
  wakeLines: number
  /** Longest one memory or summary may be, in UTF-8 bytes. */
  entryChars: number
  /** Largest one output part, in UTF-8 bytes (harness truncation headroom). */
  partChars: number
  /** Largest one output part, in lines. */
  partLines: number
}

/** Upstream's measured budgets: the defaults one deployment starts from. */
export const DEFAULT_SIZES: MemorySizes = {
  wakeLines: 96,
  entryChars: 280,
  partChars: 20_000,
  partLines: 500,
}

/** The most a knob may be: a memory has to fit both record kinds. */
export const ENTRY_CHARS_MAX = Math.min(TREE_REC - 8, LOG_REC - 40)

/** One decoded log record. */
export interface LogEntry {
  id: number
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string
  text: string
}

/** An aligned power-of-two range of memories, `[lo, hi)`. */
export interface Block {
  lo: number
  hi: number
}

// ---------------------------------------------------------------- blocks

/**
 * Tile `[0, T)` with aligned power-of-two blocks, keeping a block whole iff
 * its size is at most `alpha` times its age. Bigger alpha = coarser = fewer
 * lines; detail decays with age so recent memories stay verbatim.
 */
function tile(T: number, alpha: number): Block[] {
  let root = 1
  while (root < T) root *= 2
  const out: Block[] = []
  const stack: Block[] = [{ lo: 0, hi: root }]
  let top: Block | undefined
  while ((top = stack.pop()) !== undefined) {
    const { lo, hi } = top
    if (lo >= T) continue
    const size = hi - lo
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) / 2
      stack.push({ lo: mid, hi }, { lo, hi: mid })
    } else {
      out.push({ lo, hi })
    }
  }
  return out.sort((a, b) => a.lo - b.lo)
}

/**
 * The blocks one wake renders: at most `budget` of them, finest near T. If
 * everything fits uncompressed, nothing is compressed at all.
 * @param T - how many memories the log holds.
 * @param budget - the line cap one wake spends.
 * @returns the tiling blocks, oldest first.
 */
export function cover(T: number, budget: number): Block[] {
  if (T <= 0) return []
  if (T <= budget) {
    return Array.from({ length: T }, (_, i) => ({ lo: i, hi: i + 1 }))
  }
  let lo = 0, hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (tile(T, mid).length > budget) lo = mid
    else hi = mid
  }
  const out = tile(T, hi)
  // Block sizes jump in powers of two, so alpha alone can undershoot the
  // budget. Spend what is left on the present, where detail is worth most.
  while (out.length < budget) {
    let at = -1
    let target: Block | undefined
    for (let i = out.length - 1; i >= 0; i--) {
      const b = out[i] as Block
      if (b.hi - b.lo > 1) { at = i; target = b; break }
    }
    /* v8 ignore next -- the T <= budget shortcut guarantees budget < T here,
       so the loop spends the whole budget before running out of splittable
       blocks. */
    if (target === undefined) break
    const { lo: a, hi: b } = target
    const mid = (a + b) / 2
    out.splice(at, 1, { lo: a, hi: mid }, { lo: mid, hi: b })
  }
  return out
}

/**
 * Parse `<lo>-<hi>` as wake prints it: inclusive at both ends, and a real
 * block — an aligned power-of-two range. Without the shape check, `4-5` and
 * `5-6` would read the same record.
 * @param s - the text to parse, as wake prints it.
 * @returns the block, hi exclusive.
 */
export function parseBlockId(s: string): Block {
  const m = /^(\d+)-(\d+)$/.exec(s)
  if (!m) throw new MemoryError(`'${s}' is not a block id. Copy it from wake output.`)
  const lo = Number(m[1])
  const hi = Number(m[2]) + 1
  const n = hi - lo
  if (n < 2 || n & (n - 1) || lo % n) {
    throw new MemoryError(`${s} is not a block. Copy the id printed by wake, like 16-31.`)
  }
  return { lo, hi }
}

/**
 * Print a block the way wake and nap prompts name it: inclusive hi.
 * @param block - the block to name.
 * @returns the inclusive-hi label.
 */
export function blockName(block: Block): string {
  return `${block.lo}-${block.hi - 1}`
}

// ---------------------------------------------------------------- records

/** Right-pad text to a full record, asserting it fits (byte length). */
function pad(text: string, rec: number): Buffer {
  const b = Buffer.from(text, 'utf8')
  if (b.length > rec - 1) {
    throw new MemoryError(`Too long: ${b.length} bytes. The record holds ${rec - 1}.`)
  }
  return Buffer.concat([b, Buffer.alloc(rec - b.length - 1, 0x20), Buffer.from('\n')])
}

/** Decode one log line into id/date/text. */
function parseLogLine(line: string): LogEntry {
  const sp1 = line.indexOf(' ')
  const sp2 = line.indexOf(' ', sp1 + 1)
  return {
    id: Number(line.slice(1, sp1)),
    date: line.slice(sp1 + 1, sp2),
    text: line.slice(sp2 + 1),
  }
}

/** Decode a run of whole log records, sliced as BYTES then decoded one by one. */
function decodeLogRecords(buf: Buffer): LogEntry[] {
  const out: LogEntry[] = []
  for (let i = 0; i + LOG_REC <= buf.length; i += LOG_REC) {
    out.push(parseLogLine(buf.subarray(i, i + LOG_REC).toString('utf8').trimEnd()))
  }
  return out
}

// ---------------------------------------------------------------- store

/**
 * One permanent memory: an append-only log and its rebuildable summary tree
 * under one directory. Creating the directory IS creating the identity —
 * every other operation refuses a missing one.
 */
export class MemoryStore {
  constructor(
    readonly dir: string,
    readonly sizes: MemorySizes = DEFAULT_SIZES,
  ) {}

  /** The append-only log of every memory, one 320-byte record each. */
  get logPath(): string {
    return join(this.dir, 'LOG.txt')
  }

  /**
   * One level of the summary tree.
   * @param size - the block length the level summarizes.
   * @returns the level file path.
   */
  treePath(size: number): string {
    return join(this.dir, 'TREE', String(size))
  }

  /** Create the store. The only operation that may: creating the directory IS creating the identity.
   * @returns freshness — whether the directory was just created.
   */
  init(): { fresh: boolean } {
    const fresh = !existsSync(this.dir)
    mkdirSync(join(this.dir, 'TREE'), { recursive: true })
    if (!existsSync(this.logPath)) writeSync(openSync(this.logPath, 'a'), '')
    return { fresh }
  }

  /** Refuse to operate on a missing store: a typo'd path must error, not open a second identity. */
  private require(): void {
    if (!existsSync(this.dir)) {
      throw new MemoryError(`No memory at ${this.dir}. Initialize it first.`)
    }
    mkdirSync(join(this.dir, 'TREE'), { recursive: true })
    if (!existsSync(this.logPath)) writeSync(openSync(this.logPath, 'a'), '')
  }

  private count(path: string, rec: number): number {
    try {
      return Math.floor(statSync(path).size / rec)
    } catch (e) {
      /* v8 ignore else -- stat failures other than a raced-away file are host errors (permissions) worth surfacing raw. */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
      /* v8 ignore next -- same host-error branch as the else above. */
      throw e
    }
  }

  /**
   * How many memories the log holds.
   * @returns the record count of LOG.txt.
   */
  logLength(): number {
    this.require()
    return this.count(this.logPath, LOG_REC)
  }

  /** Drop a partial trailing record left by a crash; it was never acknowledged. Callers hold the lock. */
  private repair(path: string, rec: number): void {
    let n: number
    try {
      n = statSync(path).size
    } catch (e) {
      /* v8 ignore else -- the file existed at require() a line above; anything else is a host fs error worth surfacing raw. */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      /* v8 ignore next -- same host-error branch as the else above. */
      throw e
    }
    if (n % rec) truncateSync(path, n - (n % rec))
  }

  /**
   * Serialize one store mutation across processes. OptMem holds one flock
   * for the whole store; Node has no flock, so the whole-store lock is the
   * wx-created `LOG.txt.lock` sibling from dsh-atomic-write — a crash leaks
   * a file an operator can delete, never a held kernel lock. Concurrent
   * writers through the upstream Python tool are not excluded (flock and
   * lockfiles do not interact); sharing one store across implementations is
   * a sequential affair.
   */
  private withStoreLock<T>(operation: () => T): Promise<T> {
    return withFileLock(this.logPath, () => Promise.resolve(operation()))
  }

  /**
   * Validate one memory or summary line, trimming first: non-empty, single
   * line, within the entry byte cap.
   * @param text - the candidate line.
   * @returns the trimmed, validated text.
   */
  checkEntry(text: string): string {
    text = text.trim()
    if (!text) throw new MemoryError('Empty. A memory is one line of text.')
    if (text.includes('\n') || text.includes('\r')) {
      throw new MemoryError(`${text.split('\n').length} lines. A memory is one line: merge them, or note them separately.`)
    }
    const n = Buffer.byteLength(text, 'utf8')
    if (n > this.sizes.entryChars) {
      throw new MemoryError(`Too long: ${n} bytes, limit ${this.sizes.entryChars}. Accented characters cost more than 1 byte. Compress it further.`)
    }
    return text
  }

  /**
   * Append memories; the only way LOG.txt ever changes. Ids are assigned
   * inside the lock so two sessions noting at the same moment cannot be
   * handed the same id.
   * @param items - the dated lines to record, in order.
   * @returns the first id used.
   */
  async append(items: { date: string; text: string }[]): Promise<number> {
    this.require()
    return this.withStoreLock(() => {
      this.repair(this.logPath, LOG_REC)
      const base = this.count(this.logPath, LOG_REC)
      const fd = openSync(this.logPath, 'a')
      try {
        items.forEach(({ date, text }, k) => {
          writeSync(fd, pad(`#${base + k} ${date} ${text}`, LOG_REC))
        })
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return base
    })
  }

  /**
   * Memories [lo,hi) in one seeked read.
   * @param lo - the first memory id.
   * @param hi - one past the last memory id; reads short beyond the log end.
   * @returns the entries found.
   */
  logSlice(lo: number, hi: number): LogEntry[] {
    this.require()
    const fd = openSync(this.logPath, 'r')
    try {
      const buf = Buffer.alloc((hi - lo) * LOG_REC)
      const n = readSync(fd, buf, 0, buf.length, lo * LOG_REC)
      return decodeLogRecords(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  }

  /**
   * One memory by id.
   * @param i - the memory id.
   * @returns the entry.
   */
  logGet(i: number): LogEntry {
    const entry = this.logSlice(i, i + 1)[0]
    if (!entry) throw new MemoryError(`Memory #${i} is beyond the log.`)
    return entry
  }

  /**
   * Read an external UTF-8 text file (the `import` source). The store is
   * UTF-8 by construction, so an undecodable file is rejected outright rather
   * than silently mangled into replacement characters.
   * @param path - the import source file.
   * @returns its UTF-8 text.
   */
  readTextFile(path: string): string {
    let buf: Buffer
    try {
      buf = readFileSync(path)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      throw new MemoryError(`${path}: ${err.message}.`)
    }
    const text = buf.toString('utf8')
    if (text.includes('\uFFFD')) {
      throw new MemoryError(`${path} is not UTF-8 text. Convert it, then import again.`)
    }
    return text
  }

  /** Stream every memory in chunks; a search reads the whole log but must not hold it.
   * @returns the log entries in order.
   */
  *logScan(): Generator<LogEntry> {
    this.require()
    const fd = openSync(this.logPath, 'r')
    try {
      for (;;) {
        const buf = Buffer.alloc(LOG_REC * 4096)
        const n = readSync(fd, buf, 0, buf.length, null)
        if (!n) return
        yield* decodeLogRecords(buf.subarray(0, n - (n % LOG_REC)))
        if (n % LOG_REC) throw new MemoryError('LOG.txt is misaligned: a partial record survived repair.')
      }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * The summary of block [lo,hi), in one seek.
   * @param block - the block to read.
   * @returns the summary line, or null when not built yet.
   */
  treeGet(block: Block): string | null {
    const { lo, hi } = block
    this.require()
    const size = hi - lo
    let text = ''
    try {
      const fd = openSync(this.treePath(size), 'r')
      try {
        const rec = Buffer.alloc(TREE_REC)
        const got = readSync(fd, rec, 0, TREE_REC, Math.floor(lo / size) * TREE_REC)
        if (got === TREE_REC) text = rec.toString('utf8').trimEnd()
      } finally {
        closeSync(fd)
      }
    } catch (e) {
      /* v8 ignore else -- a level file that opened moments ago can only fail deeper reads through a host fs error worth surfacing raw. */
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      /* v8 ignore next -- same host-error branch as the else above. */
      throw e
    }
    // Empty text means no complete record: a partial trailing record left by
    // a crash was never acknowledged, and count() does not see it either, so
    // the block is not built — the next nap drops it and computes it again.
    if (!text) return null
    if (text.includes('\uFFFD')) {
      throw new MemoryError(`The summary of #${blockName({ lo, hi })} is corrupt. Forget it so the next nap rebuilds it.`)
    }
    return text
  }

  /**
   * Write block [lo,hi). Blocks are built in order, so this only ever appends one record to one level file.
   * @param block - the block to settle.
   * @param text - the one-line summary.
   * @returns false when a parallel session settled or forgot the block first.
   */
  async treePut(block: Block, text: string): Promise<boolean> {
    const { lo, hi } = block
    this.require()
    return this.withStoreLock(() => {
      const size = hi - lo
      const p = this.treePath(size)
      this.repair(p, TREE_REC)
      if (this.count(p, TREE_REC) !== lo / size) return false
      const fd = openSync(p, 'a')
      try {
        writeSync(fd, pad(text, TREE_REC))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return true
    })
  }

  /**
   * Forget block [lo,hi) and every block built from it, by truncating each
   * level back to that point. Later blocks at those levels go too and are
   * rebuilt; the log is never touched, so nothing is lost.
   * @param block - the summary to forget.
   * @returns every block the truncation dropped.
   */
  async treeDrop(block: Block): Promise<Block[]> {
    const { lo, hi } = block
    this.require()
    return this.withStoreLock(() => {
      const gone: Block[] = []
      const T = this.logLength()
      for (let size = hi - lo; size <= T; size *= 2) {
        const p = this.treePath(size)
        const k = lo / size
        const n = this.count(p, TREE_REC)
        if (n > k) {
          for (let i = k; i < n; i++) gone.push({ lo: i * size, hi: (i + 1) * size })
          truncateSync(p, k * TREE_REC)
        }
      }
      return gone
    })
  }

  /**
   * Blocks that can be built and have not been, smallest first. Each level
   * file holds a dense prefix, so its length says exactly how far that level
   * got: one stat per level, never a scan.
   * @param T - how many memories the log holds.
   * @param limit - cap on the list, smallest first.
   * @returns the due blocks.
   */
  pending(T: number, limit?: number): Block[] {
    this.require()
    const todo: Block[] = []
    for (let size = 2; size <= T; size *= 2) {
      const have = this.count(this.treePath(size), TREE_REC)
      for (let k = have; k < Math.floor(T / size); k++) {
        todo.push({ lo: k * size, hi: (k + 1) * size })
        if (limit && todo.length >= limit) return todo
      }
    }
    return todo
  }

  /** How many blocks pending() would list, without listing them.
   * @param T - how many memories the log holds.
   * @returns the due count.
   */
  pendingCount(T: number): number {
    this.require()
    let n = 0
    for (let size = 2; size <= T; size *= 2) {
      n += Math.max(0, Math.floor(T / size) - this.count(this.treePath(size), TREE_REC))
    }
    return n
  }
}
