/** MemoryStore mechanics: fixed-width records, block math, locking, crash repair. */
import { mkdtempSync, openSync, rmSync, closeSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemorySizes } from '../src/store.ts'
import { cover, DEFAULT_SIZES, ENTRY_CHARS_MAX, MemoryStore, parseBlockId, RAW_MAX } from '../src/store.ts'

let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
  store = new MemoryStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cover', () => {
  it('is empty for an empty log', () => {
    expect(cover(0, 96)).toEqual([])
  })

  it('lists every memory verbatim within budget', () => {
    expect(cover(3, 96)).toEqual([{ lo: 0, hi: 1 }, { lo: 1, hi: 2 }, { lo: 2, hi: 3 }])
  })

  it('decays detail with age over budget', () => {
    const blocks = cover(1000, 10)
    expect(blocks.length).toBeLessThanOrEqual(10)
    // The present stays verbatim; the past collapses into power-of-two blocks.
    expect(blocks.at(-1)).toEqual({ lo: 999, hi: 1000 })
    expect(blocks[0]!.hi - blocks[0]!.lo).toBeGreaterThan(1)
    // Aligned power-of-two tiling of [0, T).
    let at = 0
    for (const { lo, hi } of blocks) {
      expect(lo).toBe(at)
      const size = hi - lo
      expect(size & (size - 1)).toBe(0)
      expect(lo % size).toBe(0)
      at = hi
    }
    expect(at).toBe(1000)
  })

  it('splits the newest block to spend leftover budget on the present', () => {
    const blocks = cover(17, 5)
    expect(blocks.length).toBe(5)
    expect(blocks.at(-1)).toEqual({ lo: 16, hi: 17 })
  })
})

describe('parseBlockId', () => {
  it('parses an inclusive aligned power-of-two range', () => {
    expect(parseBlockId('16-31')).toEqual({ lo: 16, hi: 32 })
  })

  it('rejects non-ids, unaligned ranges, and non-power-of-two sizes', () => {
    for (const bad of ['abc', '0-0', '1-2', '0-2', '5-5']) {
      expect(() => parseBlockId(bad)).toThrow(MemoryError)
    }
    // 4-5 and 5-6 must not read the same record: 5-6 is unaligned.
    expect(() => parseBlockId('5-6')).toThrow(/not a block/)
    expect(parseBlockId('4-5')).toEqual({ lo: 4, hi: 6 })
  })
})

describe('MemoryStore', () => {
  it('refuses to operate before init: a typo must not open a second identity', async () => {
    // An empty directory still counts as initialized; refusal guards a path
    // that does not exist at all — the typo case.
    const ghost = new MemoryStore(join(dir, 'no-such-store'))
    expect(() => ghost.logLength()).toThrow(/No memory at/)
    await expect(ghost.append([{ date: '2026-01-01', text: 'x' }])).rejects.toThrow(/No memory at/)
  })

  it('init creates the store once and reports freshness', () => {
    const fresh = new MemoryStore(join(dir, 'store'))
    expect(fresh.init().fresh).toBe(true)
    expect(fresh.init().fresh).toBe(false)
    expect(fresh.logLength()).toBe(0)
  })

  it('appends fixed-width records seekable by id, multi-byte safe', async () => {
    store.init()
    const text = 'Café → 日本語 🎉'
    expect(await store.append([{ date: '2026-08-24', text }])).toBe(0)
    expect(await store.append([{ date: '2026-08-24', text: 'second' }])).toBe(1)
    expect(store.logLength()).toBe(2)
    expect(store.logGet(0)).toEqual({ id: 0, date: '2026-08-24', text })
    expect(store.logSlice(0, 2).map(e => e.text)).toEqual([text, 'second'])
    expect([...store.logScan()].map(e => e.id)).toEqual([0, 1])
  })

  it('rejects empty, multi-line, and over-long entries', () => {
    store.init()
    expect(() => store.checkEntry('')).toThrow(/Empty/)
    expect(() => store.checkEntry('   ')).toThrow(/Empty/)
    expect(() => store.checkEntry('a\nb')).toThrow(/2 lines/)
    expect(() => store.checkEntry('x'.repeat(281))).toThrow(/Too long: 281 bytes, limit 280/)
    expect(store.checkEntry('  padded  ')).toBe('padded')
  })

  it('repairs a torn trailing record before appending', async () => {
    store.init()
    await store.append([{ date: '2026-08-24', text: 'whole' }])
    const fd = openSync(store.logPath, 'a')
    writeSync(fd, 'PARTIAL')
    closeSync(fd)
    expect(await store.append([{ date: '2026-08-24', text: 'after crash' }])).toBe(1)
    expect(store.logGet(1).text).toBe('after crash')
  })

  it('tracks pending blocks smallest-first and settles them in order', async () => {
    store.init()
    for (let i = 0; i < 6; i++) await store.append([{ date: '2026-08-24', text: `m${i}` }])
    const T = store.logLength()
    expect(store.pending(T)).toEqual([
      { lo: 0, hi: 2 }, { lo: 2, hi: 4 }, { lo: 4, hi: 6 },
      { lo: 0, hi: 4 },
    ])
    expect(store.pendingCount(T)).toBe(4)
    expect(store.pending(T, 2)).toHaveLength(2)
    expect(store.treeGet({ lo: 0, hi: 2 })).toBeNull()
    expect(await store.treePut({ lo: 0, hi: 2 }, 'first pair')).toBe(true)
    // Out of order: the dense prefix only ever appends the next block.
    expect(await store.treePut({ lo: 4, hi: 6 }, 'skip ahead')).toBe(false)
    expect(store.treeGet({ lo: 0, hi: 2 })).toBe('first pair')
    expect(store.pendingCount(T)).toBe(3)
  })

  it('forgets a block and everything built from it by truncating levels', async () => {
    store.init()
    for (let i = 0; i < 4; i++) await store.append([{ date: '2026-08-24', text: `m${i}` }])
    await store.treePut({ lo: 0, hi: 2 }, 'a')
    await store.treePut({ lo: 2, hi: 4 }, 'b')
    await store.treePut({ lo: 0, hi: 4 }, 'ab')
    // Truncation drops every LATER block at each level too; they are rebuilt.
    const gone = await store.treeDrop({ lo: 0, hi: 2 })
    expect(gone).toEqual([{ lo: 0, hi: 2 }, { lo: 2, hi: 4 }, { lo: 0, hi: 4 }])
    expect(store.treeGet({ lo: 0, hi: 2 })).toBeNull()
    expect(store.treeGet({ lo: 2, hi: 4 })).toBeNull()
    expect(store.treeGet({ lo: 0, hi: 4 })).toBeNull()
    // The log is never touched.
    expect(store.logLength()).toBe(4)
  })

  it('reads a blank record as not built, so the next nap recomputes it', async () => {
    store.init()
    for (let i = 0; i < 2; i++) await store.append([{ date: '2026-08-24', text: `m${i}` }])
    // A crash leaves a zeroed full-width record: readable but empty.
    const fd = openSync(store.treePath(2), 'w')
    writeSync(fd, Buffer.alloc(288, 0x20))
    closeSync(fd)
    expect(store.treeGet({ lo: 0, hi: 2 })).toBeNull()
  })

  it('serializes writers through the sibling lock file and refuses an orphaned one', async () => {
    store.init()
    // An orphaned lock (a crashed writer's LOG.txt.lock) blocks appends until
    // the fixed wait runs out; recovery is an operator deleting the file.
    writeFileSync(`${store.logPath}.lock`, '0\n')
    await expect(store.append([{ date: '2026-08-24', text: 'blocked' }])).rejects.toThrow(/timed out waiting for the writer lock/)
  }, 10_000)

  it('honours custom sizes', () => {
    const small: MemorySizes = { wakeLines: 2, entryChars: 20, partChars: 40, partLines: 3 }
    const s = new MemoryStore(dir, small)
    s.init()
    expect(s.sizes).toEqual(small)
    expect(() => s.checkEntry('x'.repeat(21))).toThrow(/limit 20/)
  })
})

describe('constants', () => {
  it('keeps entry text inside both record widths', () => {
    expect(ENTRY_CHARS_MAX).toBe(280)
    expect(DEFAULT_SIZES.entryChars).toBeLessThanOrEqual(ENTRY_CHARS_MAX)
    expect(RAW_MAX).toBe(16)
  })
})

describe('cover() tiling', () => {
  it('spends leftover budget splitting the newest blocks toward raw detail', () => {
    // A generous budget splits every alpha block down to raw memories.
    expect(cover(17, 96)).toEqual(Array.from({ length: 17 }, (_, lo) => ({ lo, hi: lo + 1 })))
    // A tight budget keeps the alpha decay and spends the remainder splitting
    // the newest blocks: oldest stays a wide summary, newest goes raw.
    expect(cover(17, 4)).toEqual([
      { lo: 0, hi: 8 }, { lo: 8, hi: 12 }, { lo: 12, hi: 16 }, { lo: 16, hi: 17 },
    ])
  })

  it('stops splitting when every entry is a single memory', () => {
    expect(cover(2, 3)).toEqual([{ lo: 0, hi: 1 }, { lo: 1, hi: 2 }])
  })

  it('decays detail with age over a large memory', () => {
    const tiled = cover(300, 96)
    expect(tiled).toHaveLength(96)
    // Oldest first, covering exactly [0, 300).
    expect(tiled[0]!.lo).toBe(0)
    expect(tiled[95]!).toEqual({ lo: 299, hi: 300 })
    for (let i = 1; i < tiled.length; i++) expect(tiled[i]!.lo).toBe(tiled[i - 1]!.hi)
  })
})

describe('defensive store reads', () => {
  it('reports a logGet beyond the log', async () => {
    store.init()
    await store.append([{ date: '2026-08-24', text: 'only' }])
    expect(() => store.logGet(1)).toThrow('Memory #1 is beyond the log.')
  })

  it('reports a misaligned log instead of misparsing it', async () => {
    store.init()
    await store.append([{ date: '2026-08-24', text: 'whole' }])
    writeFileSync(store.logPath, Buffer.concat([
      Buffer.alloc(320, 0x20), Buffer.alloc(80, 0x78),
    ]))
    expect(() => [...store.logScan()]).toThrow('LOG.txt is misaligned: a partial record survived repair.')
  })

  it('reports an undecodable summary record as corrupt', async () => {
    store.init()
    for (let i = 0; i < 2; i++) await store.append([{ date: '2026-08-24', text: `m${i}` }])
    writeFileSync(store.treePath(2), Buffer.alloc(288, 0xff))
    expect(() => store.treeGet({ lo: 0, hi: 2 })).toThrow(
      'The summary of #0-1 is corrupt. Forget it so the next nap rebuilds it.')
  })

  it('recreates a missing TREE directory on an existing store', async () => {
    store.init()
    rmSync(join(dir, 'TREE'), { recursive: true })
    expect(store.logLength()).toBe(0)
  })
})

describe('store boundary assertions', () => {
  it('refuses to burn the budget when every entry is already a single memory', () => {
    // 9 > 8... T=9 with budget 12: alpha tiles big blocks, then the split
    // loop mines every block down to singles and still has budget left.
    expect(cover(9, 12)).toEqual(Array.from({ length: 9 }, (_, lo) => ({ lo, hi: lo + 1 })))
  })

  it('asserts a record cannot overflow its fixed width', async () => {
    store.init()
    // The dialogue caps entries at 280 bytes; the store itself asserts the
    // 320-byte record as the last word on the file format.
    await expect(store.append([{ date: '2026-08-24', text: 'x'.repeat(400) }])).rejects.toThrow(/Too long: 414 bytes/)
  })

  it('recreates a removed LOG.txt on an existing store directory', async () => {
    store.init()
    rmSync(store.logPath)
    expect(store.logLength()).toBe(0)
    await expect(store.append([{ date: '2026-08-24', text: 'fresh again' }])).resolves.toBe(0)
  })

  it('reads an unbuilt level whose file does not exist yet as null', async () => {
    store.init()
    expect(store.treeGet({ lo: 0, hi: 2 })).toBeNull()
  })
})
