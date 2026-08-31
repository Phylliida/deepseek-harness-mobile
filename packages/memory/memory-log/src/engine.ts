/**
 * The OptMem command dialogue over a MemoryStore, ported command for command
 * from the reference `memo` CLI: `wake [part [T]]`, `note "<line>"`,
 * `nap [lo-hi "<line>"]`, `recall <regex>`, `zoom <lo-hi>`, `forget <lo-hi>`,
 * `import <file>`. The returned text is the seam's contract — including the
 * `Run:` instructions naming the next command, which the agent sends back
 * verbatim as the next command string. Two upstream commands are deliberately
 * absent: `init` (the provider creates its store at load, from Config) and
 * `config` (cordis.yml owns the sizes; a store-level override would bypass
 * the deployment).
 *
 * Where upstream reports failure with exit 1 and stderr, this port throws
 * {@link MemoryError}; the one exception is a blocked wake, whose text is the
 * instruction the agent must read, so it returns normally.
 */
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { Block, LogEntry, MemoryStore } from './store.ts'
import { cover, parseBlockId, RAW_MAX } from './store.ts'

/** The usage text, printed for an empty command and after an unknown one. */
export const USAGE = `memory: a permanent, append-only memory for the agent.

  wake [part [T]]   read your memory. Run first, every session.
  note "..."        record one memory: one short line.
  nap [id "..."]    do the pending compressions.
  recall <regex>    search every memory ever recorded.
  zoom <lo>-<hi>    open a tree node: its two halves.
  forget <lo>-<hi>  drop a bad summary; nap rebuilds it.
  import <file>     bulk-load dated memories (bootstrap only).

Send each line a result prints after \`Run:\` as the next command, verbatim.`

/** Fail one command with an agent-actionable message. */
function die(msg: string): never {
  throw new MemoryError(msg)
}

function plural(n: number, word: string): string {
  if (n === 1) return `1 ${word}`
  if (word.endsWith('y')) word = `${word.slice(0, -1)}ie`
  else if (/[shx]$/.test(word)) word += 'e'
  return `${n} ${word}s`
}

/** `#a-b`, inclusive at both ends — how the dialogue names a block. */
function blockName({ lo, hi }: Block): string {
  return `${lo}-${hi - 1}`
}

function lineOf(e: LogEntry): string {
  return `#${e.id} ${e.date} ${e.text}`
}

/**
 * Split one command string into words, honoring single and double quotes.
 * Inside double quotes, `\"` and `\\` escape; inside single quotes nothing
 * does. This is the whole quoting grammar — the prompt teaches it by example.
 * @param command - the raw command string.
 * @returns the argument words, unescaped.
 */
export function splitArgs(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let open = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i)
    if (quote === '"') {
      if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
        cur += command.charAt(++i)
      } else if (c === '"') {
        quote = null
      } else {
        cur += c
      }
      continue
    }
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      open = true
    } else if (/\s/.test(c)) {
      if (open || cur) out.push(cur)
      cur = ''
      open = false
    } else {
      cur += c
    }
  }
  if (quote) die(`Unclosed ${quote} quote.`)
  if (open || cur) out.push(cur)
  return out
}

/** Split the document into parts that survive any output cap. */
function paginate(store: MemoryStore, lines: string[]): string[][] {
  const parts: string[][] = []
  let cur: string[] = []
  let size = 0
  for (const line of lines) {
    const n = Buffer.byteLength(line, 'utf8') + 1
    if (cur.length && (cur.length >= store.sizes.partLines || size + n > store.sizes.partChars)) {
      parts.push(cur)
      cur = []
      size = 0
    }
    cur.push(line)
    size += n
  }
  /* v8 ignore else -- page flushes happen before a line is pushed, so the final part is never empty. */
  if (cur.length) parts.push(cur)
  return parts
}

/** The instruction asking the agent to compress one block into one line. */
function napPrompt(store: MemoryStore, { lo, hi }: Block, left: number): string {
  let body: string
  if (hi - lo <= RAW_MAX) {
    body = store.logSlice(lo, hi).map(e => `  ${lineOf(e)}`).join('\n')
  } else {
    const mid = (lo + hi) / 2
    const halves: string[] = []
    for (const [a, b] of [[lo, mid], [mid, hi]] as const) {
      const s = store.treeGet({ lo: a, hi: b })
      if (s === null) {
        // pending() lists a block only after its halves settled, so a missing
        // half is a blank record — a corrupt write. Forget rebuilds it.
        die(`The summary of #${blockName({ lo: a, hi: b })} is blank. Run: forget ${blockName({ lo: a, hi: b })}`)
      }
      halves.push(`  #${blockName({ lo: a, hi: b })} ${s}`)
    }
    body = halves.join('\n')
  }
  const tail = left === 0
    ? ''
    : `\n${left === 1 ? '1 compression remains' : `${left} compressions remain`} after this one.`
  return `Compress memories #${blockName({ lo, hi })} into one line of at most ${store.sizes.entryChars} bytes.\n`
    + 'Keep what has lasting effect, drop what does not. Invent nothing.\n\n'
    + `${body}\n${tail}\n`
    + `Run: nap ${blockName({ lo, hi })} "<your line>"`
}

/**
 * The next due compression's instruction, or null when the tree is settled.
 * @param store - the store whose pending blocks are due.
 * @param T - how many memories the log holds.
 * @returns the nap request, or null when the tree is quiet.
 */
export function nextNap(store: MemoryStore, T: number): string | null {
  const todo = store.pending(T, 1)
  const [next] = todo
  if (next === undefined) return null
  return napPrompt(store, next, store.pendingCount(T) - 1)
}

/**
 * `wake [part [T]]`: read the memory, page by page, over a stable snapshot.
 * @param store - the store to read.
 * @param args - the page index and snapshot length from the command line.
 * @returns the rendered part, or the blocked-wake instruction.
 */
export function cmdWake(store: MemoryStore, args: string[]): string {
  const now = store.logLength()
  let k = 1
  let T = now
  if (args.length) {
    if (args.length > 2 || !args.every(a => /^\d+$/.test(a))) {
      die('usage: wake [part [T]]')
    }
    k = Number(args[0])
    if (args.length === 2) {
      T = Number(args[1])
      if (T > now) die(`T=${T}, but the log holds ${plural(now, 'memory')}. Run: wake`)
    }
  }
  // A part is rendered as of T, so a note landing between two parts cannot
  // shift a boundary and drop a line.
  if (!T) {
    return 'No memories yet. Record the first with: note "<one line>"\nYou are awake.'
  }
  const lines: string[] = []
  for (const block of cover(T, store.sizes.wakeLines)) {
    if (block.hi - block.lo === 1) {
      lines.push(lineOf(store.logGet(block.lo)))
      continue
    }
    let s = store.treeGet(block)
    if (s === null) {
      const nap = nextNap(store, T)
      if (nap) {
        // The ONLY reason to refuse: this document cannot be written without
        // that summary. Work that the document does not need is handed over
        // after the read instead, costing no round trip.
        return `Cannot wake: the memory context needs #${blockName(block)}, which is not compressed yet.\n`
          + `Do the ${plural(store.pendingCount(T), 'compression')} below, then run wake again.\n\n`
          + nap
      }
      s = store.treeGet(block) // a parallel session may have paid it
      /* v8 ignore next -- both reads agree in one process; they diverge only when a parallel session settles the block between them. */
      if (s === null) {
        die(`The summary of #${blockName(block)} is blank. Run: forget ${blockName(block)}`)
      }
    }
    lines.push(`#${blockName(block)} ${s}`)
  }
  const parts = paginate(store, lines)
  if (k < 1 || k > parts.length) {
    die(`No part ${k}: the memory has ${plural(parts.length, 'part')}. Run: wake`)
  }
  let out = ''
  if (parts.length > 1) {
    // The count is here so the T in `wake 2 296` reads as what it is: the
    // snapshot this document was written from.
    out += `Your memory, part ${k} of ${parts.length}, oldest first (${plural(T, 'memory')}).\n`
  }
  // The bounds check above guarantees the page index is in range.
  out += (parts[k - 1] as string[]).join('\n')
  if (k < parts.length) {
    // This footer is the only instruction that survives every output
    // truncation, so it has to say both that the read is unfinished and how
    // to continue it.
    out += `\nNot awake yet. Run: wake ${k + 1} ${T}`
  } else {
    // Always, even for a one-part memory: the contract the agent is given is
    // "run parts until one says awake", so it must always arrive.
    out += '\nYou are awake.'
    const nap = nextNap(store, T)
    if (nap) out += `\n\n${nap}`
  }
  return out
}

/**
 * Today's date, local time, as `YYYY-MM-DD` — matching upstream's `date.today()`.
 * @param now - the moment to stamp; injectable for tests.
 * @returns the ISO local date.
 */
export function todayLocal(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/**
 * `note "<line>"`: record one memory; the reply carries the next due compression.
 * @param store - the store to append to.
 * @param args - the one quoted note line.
 * @returns the ack and any nap request the note brings due.
 */
export async function cmdNote(store: MemoryStore, args: string[]): Promise<string> {
  if (args.length !== 1) {
    die(`usage: note "<one line, at most ${store.sizes.entryChars} bytes>"`)
  }
  const text = store.checkEntry(args[0] as string)
  const i = await store.append([{ date: todayLocal(), text }])
  let out = `Saved as #${i}.`
  const nap = nextNap(store, i + 1)
  if (nap) out += `\n\n${nap}`
  return out
}

/**
 * `nap [lo-hi "<line>"]`: answer the pending compressions, in order.
 * @param store - the store to settle blocks in.
 * @param args - empty to print the next due block, or the block id and summary line.
 * @returns the due request, settlement ack, or quiet-tree reply.
 */
export async function cmdNap(store: MemoryStore, args: string[]): Promise<string> {
  const T = store.logLength()
  let head: string | null = null
  if (args.length) {
    if (args.length !== 2) die('usage: nap <lo>-<hi> "<one line>"')
    const block = parseBlockId(args[0] as string)
    const [next] = store.pending(T, 1)
    if (next === undefined) return 'Nothing left to compress.'
    if (block.lo !== next.lo || block.hi !== next.hi) {
      if (store.treeGet(block) !== null) {
        return `${blockName(block)} is already settled.`
      }
      die(`Wrong block: ${args[0]}. Blocks are built in order; the next is ${blockName(next)}. Run: nap`)
    }
    /* v8 ignore next -- pending() and treePut() read the same level file in
       one process; they disagree only when a parallel session settles or
       forgets the block in between. */
    if (!await store.treePut(block, store.checkEntry(args[1] as string))) {
      return `${blockName(block)} was settled or forgotten meanwhile.`
    }
    head = `${blockName(block)} saved.`
  }
  const nap = nextNap(store, T)
  if (!nap) return head ? `${head}\nNothing left to compress.` : 'Nothing left to compress.'
  return head ? `${head}\n\n${nap}` : nap
}

/**
 * `recall <regex>`: search every memory, keeping the newest matches that fit one part.
 * @param store - the store whose log is searched.
 * @param args - the one regex.
 * @returns the matched lines and the total, capped to one part.
 */
export function cmdRecall(store: MemoryStore, args: string[]): string {
  if (args.length !== 1) die('usage: recall <regex>')
  let pat: RegExp
  try {
    pat = new RegExp(args[0] as string, 'i')
  } catch (e) {
    die(`bad regex: ${(e as Error).message}`)
  }
  // One pass, keeping only the newest matches that fit the cap wake respects
  // — a vague regex matches the whole log, and the whole log does not fit in
  // one output or in memory.
  let hits = 0
  const out: string[] = []
  let size = 0
  for (const e of store.logScan()) {
    const line = lineOf(e)
    if (!pat.test(line)) continue
    hits++
    out.push(line)
    size += Buffer.byteLength(line, 'utf8') + 1
    // One line over the part budget is still shown (wrapping beats
    // losing the only match); older matches drop first.
    while (size > store.sizes.partChars && out.length > 1) {
      size -= Buffer.byteLength(out[0] as string, 'utf8') + 1
      out.shift()
    }
  }
  if (!hits) return 'No match.'
  let text = out.join('\n')
  if (out.length < hits) {
    text += `\nNewest ${out.length} of ${plural(hits, 'match')}. Narrow the regex.`
  } else {
    text += `\n${plural(hits, 'match')}.`
  }
  return text
}

/**
 * `zoom <lo-hi>`: open one tree node into its two halves.
 * @param store - the store holding the tree.
 * @param args - the one block id.
 * @returns the two halves, summaries or raw lines.
 */
export function cmdZoom(store: MemoryStore, args: string[]): string {
  if (args.length !== 1) die('usage: zoom <lo>-<hi>   # a block id, as wake prints them')
  const { lo, hi } = parseBlockId(args[0] as string)
  const T = store.logLength()
  if (lo >= T) {
    die(`#${args[0]} is beyond the memory: it holds ${plural(T, 'memory')}. Run: wake`)
  }
  const mid = (lo + hi) / 2
  const out: string[] = []
  for (const [a, b] of [[lo, mid], [mid, hi]] as const) {
    if (a >= T) continue // the future: no memories there yet
    if (b - a === 1) {
      out.push(lineOf(store.logGet(a)))
    } else {
      out.push(`#${blockName({ lo: a, hi: b })} ${store.treeGet({ lo: a, hi: b }) ?? 'not compressed yet'}`)
    }
  }
  return out.join('\n')
}

/**
 * `forget <lo-hi>`: drop a bad summary and everything built on it; the next
 * nap computes them again. The log is untouched, so nothing is ever lost.
 * @param store - the store whose summary tree is truncated.
 * @param args - the one block id.
 * @returns the count of dropped summaries.
 */
export async function cmdForget(store: MemoryStore, args: string[]): Promise<string> {
  if (args.length !== 1) die('usage: forget <lo>-<hi>')
  const gone = await store.treeDrop(parseBlockId(args[0] as string))
  if (!gone.length) die(`No summary at ${args[0]}.`)
  return `Forgot ${plural(gone.length, 'summary')}, from ${blockName(gone[0] as Block)} up. Run: nap`
}

/**
 * `import <file>`: bulk-append 'YYYY-MM-DD <text>' lines; bootstrap only.
 * @param store - the store to append into.
 * @param args - the one file path.
 * @returns the import ack with the pending compression count.
 */
export async function cmdImport(store: MemoryStore, args: string[]): Promise<string> {
  if (args.length !== 1) die('usage: import <file>   # lines of \'YYYY-MM-DD <text>\'')
  let src: string
  try {
    src = store.readTextFile(args[0] as string)
  } catch (e) {
    die((e as MemoryError).message)
  }
  const last = store.logLength() ? store.logGet(store.logLength() - 1).date : '0000-00-00'
  const items: { date: string; text: string }[] = []
  let prev = last
  const lines = src.split('\n')
  for (const [n, raw] of lines.entries()) {
    const i = n + 1
    const line = raw.replace(/\n$/, '')
    if (!line.trim()) continue
    const sp = line.indexOf(' ')
    const date = sp < 0 ? line : line.slice(0, sp)
    const text = sp < 0 ? '' : line.slice(sp + 1).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      die(`line ${i}: expected 'YYYY-MM-DD <text>', got: ${line}`)
    }
    // Date.parse rolls impossible dates over (Feb 31 becomes March), so
    // validate the components round-trip instead.
    const [y, m, d] = date.split('-').map(Number) as [number, number, number]
    const t = new Date(Date.UTC(y, m - 1, d))
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
      die(`line ${i}: ${date} is not a real date.`)
    }
    if (date < prev) {
      die(`line ${i}: date ${date} precedes the previous memory (${prev}).`)
    }
    if (!text || Buffer.byteLength(text, 'utf8') > store.sizes.entryChars) {
      die(`line ${i}: ${Buffer.byteLength(text, 'utf8')} bytes, limit ${store.sizes.entryChars}.`)
    }
    items.push({ date, text })
    prev = date
  }
  if (!items.length) die(`${args[0]} has no memories.`)
  const base = await store.append(items)
  let out = `Imported ${plural(items.length, 'memory')}, #${base} to #${base + items.length - 1}.`
  const pendingCount = store.pendingCount(store.logLength())
  if (pendingCount) out += `\n${plural(pendingCount, 'compression')} pending. Run: nap`
  return out
}

const COMMANDS: Record<string, (store: MemoryStore, args: string[]) => string | Promise<string>> = {
  wake: cmdWake,
  note: cmdNote,
  nap: cmdNap,
  recall: cmdRecall,
  zoom: cmdZoom,
  forget: cmdForget,
  import: cmdImport,
}

/**
 * Run one command string against the store: the seam's whole dispatch.
 *
 * @param store - the store to run against.
 * @param command - one command in the OptMem grammar.
 * @returns the command's output text.
 */
export async function runCommand(store: MemoryStore, command: string): Promise<string> {
  const [verb, ...args] = splitArgs(command)
  if (verb === undefined) return USAGE
  const cmd = COMMANDS[verb]
  if (!cmd) die(`No such command: ${verb}\n\n${USAGE}`)
  return cmd(store, args)
}
