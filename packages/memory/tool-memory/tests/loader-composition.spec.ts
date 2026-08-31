// REAL-composition proof: dsh-tool-memory booted through the real Loader from a
// cordis.yml, composed with dsh-memory-log configured with a real store
// directory, and exercised through the actual tool pipeline.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LogMemory from '@deepseek-ai/dsh-memory-log'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml composing the memory tool over the log provider.
 * @returns the booted context and the store directory the provider was given.
 */
async function boot(): Promise<{ ctx: Context; storeDir: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const storeDir = join(root, 'mem')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory-log'",
    '  config:',
    `    directory: ${JSON.stringify(storeDir)}`,
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-memory-log', LogMemory],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, storeDir }
}

describe('tool-memory real Loader composition through cordis.yml', () => {
  it('registers the memory tool and the prompt section', async () => {
    const { ctx } = await boot()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('memory')
    expect(names.filter(n => n.startsWith('memory'))).toHaveLength(1)
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(s => s.name === 'tool:memory')).toBe(true)
  }, 30_000)

  it('executes note then wake through the real pipeline', async () => {
    const { ctx } = await boot()
    const noted = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('note'),
      name: 'memory',
      arguments: { command: 'note "The deployment runs on pnpm workspaces."' },
    })
    expect(noted.isError).toBe(false)
    expect(resultText(noted)).toBe('Saved as #0.')

    const woken = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('wake'),
      name: 'memory',
      arguments: { command: 'wake' },
    })
    expect(woken.isError).toBe(false)
    expect(resultText(woken)).toMatch(
      /^#0 \d{4}-\d{2}-\d{2} The deployment runs on pnpm workspaces\.\nYou are awake\.$/,
    )
  }, 30_000)

  it('fails loud at load when the provider config is mistyped', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-memory-log'",
      '  config:',
      '    wakeLines: many',
      "- name: '@deepseek-ai/dsh-tool-memory'",
      '',
    ].join('\n'))
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-memory-log', LogMemory],
      ['@deepseek-ai/dsh-tool-memory', ToolMemory],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await expect(
      ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
        .then(() => ctx.loader.await()),
    ).rejects.toThrow(/wakeLines/)
  }, 30_000)
})
