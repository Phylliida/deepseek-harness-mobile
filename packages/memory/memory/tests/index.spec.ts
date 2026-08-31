/** Seam contract test: the abstract service registers as ctx.memory; MemoryError is distinguishable. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DefaultExport, { MemoryError, MemoryService } from '../src/index.ts'

/** Minimal concrete provider: echoes the command, no storage. */
class StubMemory extends MemoryService {
  run(command: string): Promise<string> {
    return Promise.resolve(`ran: ${command}`)
  }
}

describe('MemoryService seam', () => {
  it('exposes the abstract class as both the default and the named export', () => {
    expect(DefaultExport).toBe(MemoryService)
  })

  it('registers a subclass as the ctx.memory service taking one command string', async () => {
    const ctx = new Context()
    await ctx.plugin(StubMemory)
    expect(ctx.memory).toBeInstanceOf(StubMemory)
    await expect(ctx.memory.run('wake')).resolves.toBe('ran: wake')
    await ctx.fiber.dispose()
  })

  it('marks MemoryError with a stable name so Consumers can tell it apart', () => {
    const error = new MemoryError('bad block id')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MemoryError')
    expect(error.message).toBe('bad block id')
  })
})
