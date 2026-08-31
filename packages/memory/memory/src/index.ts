/**
 * Memory Service Definition (`ctx.memory`): a permanent, agent-curated memory
 * that outlives every session, compaction, model, and vendor change. The seam
 * follows the [OptMem](https://github.com/VictorTaelin/OptMem) interface
 * exactly: one command string in, the OptMem dialogue text out. The command
 * grammar is `wake [part [T]]`, `note "<line>"`, `nap [lo-hi "<line>"]`,
 * `recall <regex>`, `zoom <lo-hi>`, `forget <lo-hi>`; any line a result
 * prints after `Run:` is the next command to send, verbatim. Compression is
 * agent-in-the-loop: providers never summarize by themselves — they ask, in
 * the result text, and the agent answers with `nap`. The rationale for a
 * native seam over the MCP memory bridges is in the
 * [memory seam Agent Note](../../../../.agents/notes/implemented/feature/2026-08-24-memory-capability-seam.md).
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * A memory command failed in a way the calling agent can act on: an over-long
 * line, a mistyped block id, a corrupt summary. Providers throw this (never a
 * bare Error) so Consumers can surface the message verbatim.
 */
export class MemoryError extends Error {
  override readonly name = 'MemoryError'
}

/**
 * Abstract permanent-memory service; load one implementation per context as
 * `ctx.memory`. The contract is the OptMem dialogue: results are the exact
 * text the agent reads, including its instructions (`Run:` lines, "You are
 * awake.", nap requests). Composing additional prose around results is a
 * layering violation — the text IS the seam.
 */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory')
  }

  /**
   * Run one memory command.
   *
   * @param command - one command in the OptMem grammar, e.g. `wake`,
   *   `wake 2 296`, `note "one line"`, `nap 0-1 "summary"`, `recall foo|bar`,
   *   `zoom 16-31`, `forget 16-31`. An empty or whitespace command returns the
   *   usage text.
   * @returns the command's output text.
   * @throws {MemoryError} when the command is malformed or names something the
   *   store does not hold.
   */
  abstract run(command: string): Promise<string>
}

export default MemoryService
