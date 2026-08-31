/**
 * The model-facing `memory` tool over `ctx.memory`: one command string in,
 * the OptMem dialogue text out — the whole seam speaks through it. This
 * package owns the tool schema, the command grammar guidance, and the
 * system-prompt section teaching the wake-first / note-durable /
 * subagent-skip discipline; it never touches storage. The tool is a thin
 * pass-through by design: the provider's result text already IS the
 * model-facing answer, `Run:` lines included.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MEMORY_PROMPT } from './prompt.ts'

export { MEMORY_PROMPT } from './prompt.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/** Services required by the memory tool. */
export const inject = ['tools', 'memory', 'systemPrompt']

const DESCRIPTION =
  'Your permanent memory, on disk, surviving every session, compaction, model, and vendor change. '
  + 'Send ONE command string: wake (first call of every session, before any other work), '
  + 'note "one durable line", nap [lo-hi "summary"] (answers due compressions), '
  + 'recall REGEX (search every memory), zoom lo-hi (open a summary-tree node), '
  + 'forget lo-hi (drop a wrong summary for rebuild), '
  + 'projects (list project memories under the working directory), '
  + 'use NAME / use global (switch between a project memory and the global one). '
  + 'Do exactly what the result prints; any line after "Run:" is your next command string, verbatim.'

/**
 * Register the `memory` tool and the prompt section.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:memory',
    // Early in the 100–199 tool-guidance band: the section mandates startup
    // behavior, so it precedes per-tool usage guidance.
    order: 105,
    text: MEMORY_PROMPT,
  })

  ctx.tools.register(defineTool({
    name: 'memory',
    description: DESCRIPTION,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description:
          'One command in the memory grammar, e.g. "wake", "wake 2 296", "note \\"The user prefers tea\\"", '
          + '"nap 0-1 \\"User drinks tea; repo uses pnpm\\"", "recall tea|coffee", "zoom 0-31", "forget 0-31". '
          + 'Quote arguments containing spaces with double quotes; \\" and \\\\ escape inside them.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
    },
    async execute(args) {
      return { text: await ctx.memory.run(args.command) }
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      // split() always yields at least one element, blank command included.
      title: `memory ${args.command.trim().split(/\s/, 1)[0] as string}`.trim(),
      kind: 'other',
      rawInput: args.command,
    }),
  }))
}
