/** The OptMem command dialogue, pinned verbatim: every command, every failure line. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemorySizes } from '../src/store.ts'
import { MemoryStore } from '../src/store.ts'
import { runCommand, splitArgs, todayLocal, USAGE } from '../src/engine.ts'

let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-engine-'))
  store = new MemoryStore(dir)
  store.init()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const run = (command: string) => runCommand(store, command)

/** A store whose part budgets force paging after a few lines. */
function pagedStore(): MemoryStore {
  const sizes: MemorySizes = { wakeLines: 96, entryChars: 280, partChars: 64, partLines: 2 }
  const s = new MemoryStore(dir, sizes)
  return s
}

/** Record `count` notes, answering every due compression with `summary of <block>`. */
async function fill(target: MemoryStore, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await runCommand(target, `note "filler ${i}"`)
    for (let guard = 0; guard < 100; guard++) {
      const ask = await runCommand(target, 'nap')
      if (ask === 'Nothing left to compress.') break
      const block = /Run: nap (\d+-\d+)/.exec(ask)?.[1]
      if (!block) throw new Error(`no nap block in: ${ask}`)
      await runCommand(target, `nap ${block} "summary of ${block}"`)
    }
  }
}

describe('dispatch and quoting', () => {
  it('prints usage for an empty command and dies on an unknown one', async () => {
    expect(await run('')).toBe(USAGE)
    expect(await run('   ')).toBe(USAGE)
    await expect(run('dance')).rejects.toThrow(`No such command: dance\n\n${USAGE}`)
  })

  it('splits single and double quotes with escapes, and rejects an open quote', () => {
    expect(splitArgs('note "a b"')).toEqual(['note', 'a b'])
    expect(splitArgs("note 'a b'")).toEqual(['note', 'a b'])
    expect(splitArgs('note "a\\"b\\\\c"')).toEqual(['note', 'a"b\\c'])
    expect(splitArgs('nap 0-1 "two  spaces"')).toEqual(['nap', '0-1', 'two  spaces'])
    expect(splitArgs('note ""')).toEqual(['note', ''])
    expect(() => splitArgs('note "unclosed')).toThrow(/Unclosed " quote/)
    expect(() => splitArgs("note 'unclosed")).toThrow(/Unclosed ' quote/)
  })

  it('stamps notes with the local date like upstream date.today()', () => {
    expect(todayLocal(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(todayLocal(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('note', () => {
  it('acknowledges the assigned id and asks the first compression at two memories', async () => {
    expect(await run('note "first memory"')).toBe('Saved as #0.')
    const second = await run('note "second memory"')
    expect(second).toBe(
      'Saved as #1.\n\n'
      + 'Compress memories #0-1 into one line of at most 280 bytes.\n'
      + 'Keep what has lasting effect, drop what does not. Invent nothing.\n\n'
      + `  #0 ${todayLocal()} first memory\n`
      + `  #1 ${todayLocal()} second memory\n\n`
      + 'Run: nap 0-1 "<your line>"',
    )
  })

  it('rejects usage, empty, multi-line, and over-long notes', async () => {
    await expect(run('note')).rejects.toThrow('usage: note "<one line, at most 280 bytes>"')
    await expect(run('note "a" "b"')).rejects.toThrow('usage: note')
    await expect(run('note ""')).rejects.toThrow(/Empty/)
    await expect(run('note "x"')).resolves.toBe('Saved as #0.')
    await expect(runCommand(store, 'note "line1\nline2"')).rejects.toThrow(/2 lines/)
    await expect(run(`note "${'x'.repeat(281)}"`)).rejects.toThrow(/Too long: 281 bytes, limit 280/)
  })
})

describe('nap', () => {
  it('answers in order and chains the next due compression', async () => {
    await run('note "a"')
    await run('note "b"')
    expect(await run('nap')).toContain('Compress memories #0-1')
    expect(await run('nap 0-1 "the pair"')).toBe('0-1 saved.\nNothing left to compress.')
    expect(await run('nap')).toBe('Nothing left to compress.')
    expect(await run('nap 0-1 "again"')).toBe('Nothing left to compress.')
  })

  it('rejects a wrong-block answer naming the real next block', async () => {
    for (const t of ['a', 'b', 'c', 'd']) await run(`note "${t}"`)
    // 0-3 is not next (0-1 is), and unsettled, so the answer is refused.
    await expect(run('nap 0-3 "skip"')).rejects.toThrow(/Wrong block: 0-3\. Blocks are built in order; the next is 0-1\. Run: nap/)
    await run('nap 0-1 "the pair"')
    // An out-of-order but already-settled block reports without disturbing the tree.
    expect(await run('nap 0-1 "again"')).toBe('0-1 is already settled.')
  })

  it('rejects usage and a bad answer line', async () => {
    await run('note "a"')
    await run('note "b"')
    await expect(run('nap 0-1')).rejects.toThrow('usage: nap <lo>-<hi> "<one line>"')
    await expect(run('nap 0-1 ""')).rejects.toThrow(/Empty/)
    await expect(run('zip 0-1 "x"')).rejects.toThrow(/No such command: zip/)
  })

  it('quotes raw lines for small blocks and half summaries for large ones', async () => {
    await fill(store, 32)
    await runCommand(store, 'forget 0-31')
    const ask = await run('nap')
    expect(ask).toContain('Compress memories #0-31')
    expect(ask).toContain('  #0-15 summary of 0-15\n  #16-31 summary of 16-31')
    expect(ask).toContain('Run: nap 0-31 "<your line>"')
    // Rebuild, then drop 0-15: truncation takes 16-31 and the root too,
    // leaving three due compressions, the first quoting RAW log lines.
    await run('nap 0-31 "the rebuilt root"')
    await runCommand(store, 'forget 0-15')
    const raw = await run('nap')
    expect(raw).toContain(`  #0 ${todayLocal()} filler 0`)
    expect(raw).toContain(`  #15 ${todayLocal()} filler 15`)
    expect(raw).toContain('2 compressions remain after this one.')
  })
})

describe('wake', () => {
  it('reads an empty memory and invites the first note', async () => {
    expect(await run('wake')).toBe('No memories yet. Record the first with: note "<one line>"\nYou are awake.')
  })

  it('renders verbatim memories within the line budget and closes with awake', async () => {
    await fill(store, 3)
    expect(await run('wake')).toBe(
      `#0 ${todayLocal()} filler 0\n#1 ${todayLocal()} filler 1\n#2 ${todayLocal()} filler 2\nYou are awake.`,
    )
  })

  it('paginates over the part budgets and holds the snapshot stable', async () => {
    const paged = pagedStore()
    for (let i = 0; i < 5; i++) await runCommand(paged, `note "memory line number ${i}"`)
    // partLines 2 but partChars 64 fits only one ~38-byte line: five parts.
    const first = await runCommand(paged, 'wake')
    expect(first).toContain('Your memory, part 1 of 5, oldest first (5 memories).')
    expect(first).toContain('Not awake yet. Run: wake 2 5')
    // A note landing between parts must not shift a boundary.
    await runCommand(paged, 'note "late arrival"')
    const second = await runCommand(paged, 'wake 2 5')
    expect(second).toContain('part 2 of 5')
    expect(second).toContain('Not awake yet. Run: wake 3 5')
    const last = await runCommand(paged, 'wake 5 5')
    expect(last).toContain('You are awake.')
    expect(last).not.toContain('late arrival')
    await expect(runCommand(paged, 'wake 6 5')).rejects.toThrow(/No part 6: the memory has 5 parts\. Run: wake/)
    await expect(runCommand(paged, 'wake 1 99')).rejects.toThrow(/T=99, but the log holds 6 memories\. Run: wake/)
    await expect(runCommand(paged, 'wake x')).rejects.toThrow('usage: wake [part [T]]')
  })

  it('refuses when the context needs an unbuilt summary, then reads after the nap', async () => {
    const sizes: MemorySizes = { wakeLines: 3, entryChars: 280, partChars: 20_000, partLines: 500 }
    const small = new MemoryStore(dir, sizes)
    // Six memories, all compressions settled, then the root summary dropped.
    for (let i = 0; i < 6; i++) await runCommand(small, `note "m${i}"`)
    await fill(small, 0) // nothing new; settle below
    for (let guard = 0; guard < 50; guard++) {
      const ask = await runCommand(small, 'nap')
      if (ask === 'Nothing left to compress.') break
      const block = /Run: nap (\d+-\d+)/.exec(ask)![1]!
      await runCommand(small, `nap ${block} "sum ${block}"`)
    }
    await runCommand(small, 'forget 0-3')
    const blocked = await runCommand(small, 'wake')
    expect(blocked).toContain('Cannot wake: the memory context needs #0-3, which is not compressed yet.')
    expect(blocked).toContain('then run wake again')
    expect(blocked).toContain('Run: nap 0-3 "<your line>"')
    await runCommand(small, 'nap 0-3 "the whole first four"')
    const woken = await runCommand(small, 'wake')
    expect(woken).toContain('#0-3 the whole first four')
    expect(woken).toContain('You are awake.')
  })

  it('hands a due compression over after a completed read', async () => {
    await run('note "a"')
    await run('note "b"')
    const out = await run('wake')
    expect(out).toContain('You are awake.\n\nCompress memories #0-1 into one line')
    expect(out).toContain('Run: nap 0-1 "<your line>"')
  })
})

describe('recall', () => {
  it('searches case-insensitively and reports totals', async () => {
    await fill(store, 4)
    expect(await run('recall FILLER.[01]')).toBe(
      `#0 ${todayLocal()} filler 0\n#1 ${todayLocal()} filler 1\n2 matches.`,
    )
    expect(await run('recall nothing-matches-this')).toBe('No match.')
    await expect(run('recall (')).rejects.toThrow(/bad regex/)
    await expect(run('recall')).rejects.toThrow('usage: recall <regex>')
  })

  it('keeps only the newest matches that fit one part', async () => {
    const sizes: MemorySizes = { wakeLines: 96, entryChars: 280, partChars: 90, partLines: 500 }
    const small = new MemoryStore(dir, sizes)
    for (let i = 0; i < 5; i++) await runCommand(small, `note "match me ${i}"`)
    const out = await runCommand(small, 'recall match')
    expect(out).toContain('match me 4')
    expect(out).toMatch(/Newest \d of 5 matches\. Narrow the regex\./)
  })
})

describe('zoom', () => {
  it('opens a settled node into its two halves, raw at the leaves', async () => {
    await fill(store, 4)
    expect(await run('zoom 0-3')).toBe('#0-1 summary of 0-1\n#2-3 summary of 2-3')
    expect(await run('zoom 0-1')).toBe(`#0 ${todayLocal()} filler 0\n#1 ${todayLocal()} filler 1`)
  })

  it('marks an unbuilt half and rejects blocks beyond the memory', async () => {
    await fill(store, 6)
    await runCommand(store, 'forget 0-1')
    expect(await run('zoom 0-3')).toBe('#0-1 not compressed yet\n#2-3 not compressed yet')
    await expect(run('zoom 8-15')).rejects.toThrow(/#8-15 is beyond the memory: it holds 6 memories\. Run: wake/)
    await expect(run('zoom 1-2')).rejects.toThrow(/not a block/)
    await expect(run('zoom nope')).rejects.toThrow(/not a block id/)
    await expect(run('zoom')).rejects.toThrow(/usage: zoom/)
  })
})

describe('forget', () => {
  it('drops a summary and its dependents, asking the next nap to rebuild', async () => {
    await fill(store, 4)
    expect(await run('forget 0-1')).toBe('Forgot 3 summaries, from 0-1 up. Run: nap')
    expect(await run('nap')).toContain('Compress memories #0-1')
    await expect(run('forget 0-1')).rejects.toThrow('No summary at 0-1.')
    await expect(run('forget')).rejects.toThrow('usage: forget <lo>-<hi>')
  })
})

describe('import', () => {
  it('bulk-loads dated lines and reports the pending compressions', async () => {
    const src = join(dir, 'import.txt')
    writeFileSync(src, '2026-01-01 old fact one\n\n2026-01-02 old fact two\n')
    expect(await run(`import ${src}`)).toBe('Imported 2 memories, #0 to #1.\n1 compression pending. Run: nap')
    expect(store.logGet(0)).toEqual({ id: 0, date: '2026-01-01', text: 'old fact one' })
  })

  it('rejects disorder, impossible dates, non-dates, and over-long lines', async () => {
    const src = join(dir, 'bad.txt')
    writeFileSync(src, '2026-01-02 later\n2026-01-01 earlier\n')
    await expect(run(`import ${src}`)).rejects.toThrow(/line 2: date 2026-01-01 precedes the previous memory/)
    writeFileSync(src, '2026-02-31 not real\n')
    await expect(run(`import ${src}`)).rejects.toThrow(/line 1: 2026-02-31 is not a real date\./)
    writeFileSync(src, 'no-date-here\n')
    await expect(run(`import ${src}`)).rejects.toThrow(/line 1: expected 'YYYY-MM-DD <text>', got: no-date-here/)
    writeFileSync(src, `2026-01-01 ${'x'.repeat(281)}\n`)
    await expect(run(`import ${src}`)).rejects.toThrow(/line 1: 281 bytes, limit 280\./)
    writeFileSync(src, '\n\n')
    await expect(run(`import ${src}`)).rejects.toThrow(/has no memories\./)
    await expect(run('import /no/such/file.txt')).rejects.toThrow(/\/no\/such\/file\.txt:/)
    writeFileSync(src, Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(run(`import ${src}`)).rejects.toThrow(/is not UTF-8 text\./)
    await expect(run('import')).rejects.toThrow(/usage: import <file>/)
  })

  it('refuses dates before the existing log tail', async () => {
    await run('note "today note"')
    const src = join(dir, 'past.txt')
    writeFileSync(src, '2020-01-01 ancient\n')
    await expect(run(`import ${src}`)).rejects.toThrow(/precedes the previous memory/)
  })
})

describe('corrupt-state dialogue', () => {
  it('tells wake to forget a blank summary record (count says built, bytes say blank)', async () => {
    const sizes: MemorySizes = { wakeLines: 3, entryChars: 280, partChars: 20_000, partLines: 500 }
    const small = new MemoryStore(dir, sizes)
    for (let i = 0; i < 6; i++) await runCommand(small, `note "m${i}"`)
    await runCommand(small, 'nap 0-1 "s01"')
    await runCommand(small, 'nap 2-3 "s23"')
    await runCommand(small, 'nap 4-5 "s45"')
    await runCommand(small, 'nap 0-3 "s03"')
    // Blank the level-4 record (the summary wake renders) out from under its
    // own length: count sees a record, the bytes are spaces.
    writeFileSync(small.treePath(4), Buffer.alloc(288, 0x20))
    await expect(runCommand(small, 'wake')).rejects.toThrow(
      'The summary of #0-3 is blank. Run: forget 0-3')
  })

  it('tells nap to forget a blank half-source instead of quoting it', async () => {
    await fill(store, 32)
    await runCommand(store, 'forget 0-31')
    // Blank record 0 of level 16 while record 1 stays: count still says both
    // halves settled, so the root nap is due — but its 0-15 source is blank.
    const level16 = store.treePath(16)
    const bytes = Buffer.concat([Buffer.alloc(288, 0x20), readFileSync(level16).subarray(288)])
    writeFileSync(level16, bytes)
    await expect(run('nap')).rejects.toThrow('The summary of #0-15 is blank. Run: forget 0-15')
  })

  it('zooms over a block whose far half is not in the future it skips', async () => {
    await run('note "a"')
    await run('note "b"')
    await run('nap 0-1 "the pair"')
    expect(await run('zoom 0-3')).toBe('#0-1 the pair')
  })

  it('wakes a larger-than-raw memory through summaries and raw tail lines', async () => {
    await fill(store, 17)
    const out = await run('wake')
    // cover(17, 96) decays to raw line by line; every memory appears verbatim.
    expect(out).toContain(`#0 ${todayLocal()} filler 0`)
    expect(out).toContain(`#16 ${todayLocal()} filler 16`)
    expect(out).toContain('You are awake.')
  })

  it('imports a single memory without inventing pending work', async () => {
    const src = join(dir, 'one.txt')
    writeFileSync(src, '2026-01-01 lone fact\n')
    expect(await run(`import ${src}`)).toBe('Imported 1 memory, #0 to #0.')
  })
})

describe('paged wake follow-ups', () => {
  it('renders a later part without passing T (defaults to now)', async () => {
    const sizes: MemorySizes = { wakeLines: 96, entryChars: 280, partChars: 64, partLines: 2 }
    const paged = new MemoryStore(dir, sizes)
    for (let i = 0; i < 5; i++) await runCommand(paged, `note "memory line number ${i}"`)
    const last = await runCommand(paged, 'wake 5')
    expect(last).toContain('part 5 of 5')
    expect(last).toContain('You are awake.')
  })
})
