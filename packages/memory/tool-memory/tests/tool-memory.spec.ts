/**
 * End-to-end tool behavior: dsh-tool-memory mounted on a real ToolRuntime and
 * SystemPrompt over a real LogMemory store in a temporary directory; the one
 * `memory` tool is executed through ctx.tools.execute and the OptMem dialogue
 * text is asserted verbatim where it is deterministic.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import LogMemory from '@deepseek-ai/dsh-memory-log'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as tool from '../src/index.ts'
import { MEMORY_PROMPT } from '../src/index.ts'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let callCounter = 0

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-tool-memory-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LogMemory, { directory: dir })
  await ctx.plugin(tool)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

interface ToolResult {
  isError: boolean
  content: { type: string; text?: string }[]
}

function call(command: string): Promise<ToolResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'memory',
    arguments: { command },
  })
}

function text(result: ToolResult): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Record two memories and answer the compression the second one brings due. */
async function notePairAndSettle(): Promise<void> {
  await call('note "The user prefers concise answers."')
  await call('note "The project builds with pnpm."')
  await call('nap 0-1 "User wants concise answers; the project builds with pnpm."')
}

describe('dsh-tool-memory', () => {
  it('registers exactly one memory tool taking a command string', () => {
    const schemas = ctx.tools.schemas()
    const memory = schemas.filter(s => s.name === 'memory')
    expect(memory).toHaveLength(1)
    expect(JSON.stringify(memory[0]!)).toContain('"command"')
  })

  it('contributes the tool:memory system-prompt section', async () => {
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'tool:memory')
    expect(section).toBeDefined()
    expect(section!.text).toBe(MEMORY_PROMPT)
  })

  it('wakes an empty memory', async () => {
    const result = await call('wake')
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('No memories yet. Record the first with: note "<one line>"\nYou are awake.')
  })

  it('notes a memory and acknowledges the assigned id', async () => {
    const result = await call('note "The user prefers concise answers."')
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Saved as #0.')
  })

  it('hands over the compression a second note brings due, as a copy-pasteable Run line', async () => {
    await call('note "The user prefers concise answers."')
    const result = await call('note "The project builds with pnpm."')
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(new RegExp(
      '^Saved as #1\\.\\n'
      + '\\n'
      + 'Compress memories #0-1 into one line of at most 280 bytes\\.\\n'
      + 'Keep what has lasting effect, drop what does not\\. Invent nothing\\.\\n'
      + '\\n'
      + '  #0 \\d{4}-\\d{2}-\\d{2} The user prefers concise answers\\.\\n'
      + '  #1 \\d{4}-\\d{2}-\\d{2} The project builds with pnpm\\.\\n'
      + '\\n'
      + 'Run: nap 0-1 "<your line>"$',
    ))
  })

  it('settles an answered compression, then reports a quiet tree', async () => {
    await call('note "a"')
    await call('note "b"')
    expect(text(await call('nap'))).toContain('Run: nap 0-1 "<your line>"')
    expect(text(await call('nap 0-1 "a and b"'))).toBe('0-1 saved.\nNothing left to compress.')
    expect(text(await call('nap'))).toBe('Nothing left to compress.')
  })

  it('wakes with the recorded memories in the OptMem format', async () => {
    await notePairAndSettle()
    const result = await call('wake')
    expect(result.isError).toBe(false)
    expect(text(result)).toMatch(new RegExp(
      '^#0 \\d{4}-\\d{2}-\\d{2} The user prefers concise answers\\.\\n'
      + '#1 \\d{4}-\\d{2}-\\d{2} The project builds with pnpm\\.\\n'
      + 'You are awake\\.$',
    ))
  })

  it('recalls, zooms, and forgets through the one command string', async () => {
    await notePairAndSettle()
    expect(text(await call('recall CONCISE')))
      .toMatch(/^#0 \d{4}-\d{2}-\d{2} The user prefers concise answers\.\n1 match\.$/)
    expect(text(await call('zoom 0-1'))).toMatch(/concise answers/)
    expect(text(await call('forget 0-1'))).toBe('Forgot 1 summary, from 0-1 up. Run: nap')
    expect(text(await call('nap'))).toMatch(/^Compress memories #0-1 /)
  })

  it('surfaces a seam error as an error result', async () => {
    await notePairAndSettle()
    const result = await call('zoom 5-6')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('5-6 is not a block')
  })

  it('presents a call by its command verb', () => {
    const registered = ctx.tools.get('memory')!
    const present = (args: { command: string }) => registered.presentCall!(args)
    expect(present({ command: 'wake 2 296' }))
      .toEqual({ card: 'generic', title: 'memory wake', kind: 'other', rawInput: 'wake 2 296' })
    expect(present({ command: 'note "the user likes tea"' }))
      .toEqual({ card: 'generic', title: 'memory note', kind: 'other', rawInput: 'note "the user likes tea"' })
  })

  it('unregisters the tool and the prompt section when its fiber is disposed (HMR-safety)', async () => {
    const own = new Context()
    await own.plugin(SystemPrompt)
    await own.plugin(ToolRuntime)
    const ownDir = mkdtempSync(join(tmpdir(), 'dsh-tool-memory-hmr-'))
    try {
      await own.plugin(LogMemory, { directory: ownDir })
      const fiber = await own.plugin(tool)
      expect(own.tools.schemas().some(s => s.name === 'memory')).toBe(true)
      expect((await own.systemPrompt.assemble()).sections.some(s => s.name === 'tool:memory')).toBe(true)
      await fiber.dispose()
      expect(own.tools.schemas().some(s => s.name === 'memory')).toBe(false)
      expect((await own.systemPrompt.assemble()).sections.some(s => s.name === 'tool:memory')).toBe(false)
    } finally {
      await own.fiber.dispose()
      rmSync(ownDir, { recursive: true, force: true })
    }
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-memory')
    expect(tool.inject).toEqual(['tools', 'memory', 'systemPrompt'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-memory')
    expect(unwrapped.inject).toEqual(['tools', 'memory', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
