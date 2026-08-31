/**
 * The MEMORY_PROMPT section text, pinned: it is model-facing in full and its
 * clauses carry behavior (wake-first, durable-only notes, subagent exclusion),
 * so every clause is asserted individually rather than snapshot-blindly.
 */
import { describe, expect, it } from 'vitest'
import { MEMORY_PROMPT } from '../src/prompt.ts'

describe('MEMORY_PROMPT', () => {
  it('mandates wake before any other tool call, in every session', () => {
    expect(MEMORY_PROMPT).toContain('before any other tool call, in every session')
  })

  it('limits notes to durable facts and bans transient status (upstream issue #14)', () => {
    expect(MEMORY_PROMPT).toContain('whenever you learn something of lasting effect')
    expect(MEMORY_PROMPT).toContain('Do NOT note transient state')
    expect(MEMORY_PROMPT).toContain('test counts')
  })

  it('commands verbatim Run-line copyback for due compressions', () => {
    expect(MEMORY_PROMPT).toContain('send the printed Run: line verbatim as the next command string')
  })

  it('teaches recall and zoom in the command grammar', () => {
    expect(MEMORY_PROMPT).toContain('{ "command": "recall <regex>" }')
    expect(MEMORY_PROMPT).toContain('{ "command": "zoom <a-b>" }')
  })

  it('excludes subagents absolutely, as spawn-time instruction text', () => {
    expect(MEMORY_PROMPT).toContain('A subagent is not: it must never run the memory tool')
    expect(MEMORY_PROMPT).toContain("You are a subagent. Don't run the memory tool.")
  })

  it('teaches per-project scoping: projects lists, use switches, store-first note discipline', () => {
    expect(MEMORY_PROMPT).toContain('{ "command": "projects" } lists the projects under the working directory')
    expect(MEMORY_PROMPT).toContain('{ "command": "use <name>" } switches to that project')
    expect(MEMORY_PROMPT).toContain('{ "command": "use global" }')
    expect(MEMORY_PROMPT).toContain('Choose the store first')
  })

  it('contains no unrendered upstream template slot', () => {
    expect(MEMORY_PROMPT).not.toContain('{memo}')
  })
})
