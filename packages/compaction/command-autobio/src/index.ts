/**
 * Human-facing `/autobio` command: reports and toggles the autobiographical
 * compaction backend's automatic folding. The backend keeps working while
 * disabled — this switches off the between-step pass that forms memories on
 * its own, not the engine itself.
 * @module @deepseek-ai/dsh-command-autobio
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { AutobiographicalCompactionEngine } from '@deepseek-ai/dsh-compaction-autobiographical'

export const name = 'command-autobio'
export const inject = ['commands', 'compaction']

const USAGE = 'Usage: /autobio [on|off|status]'

/**
 * The backed engine, when the loaded compaction service is this backend.
 * Compaction is a seam with several providers, so a command bound to one
 * backend has to establish which provider it is facing.
 */
function engineOf(ctx: Context): AutobiographicalCompactionEngine | undefined {
  const service: unknown = ctx.compaction
  return service instanceof AutobiographicalCompactionEngine ? service : undefined
}

/** One line describing the state folding is in after this command ran. */
function stateText(enabled: boolean): string {
  return enabled
    ? 'Autobiographical folding is on: aged history folds into recollections at every step boundary.'
    : 'Autobiographical folding is off: the engine forms no memories on its own. '
      + '/compact and other explicit requests still fold.'
}

/** Execute one `/autobio` invocation. */
function executeAutobio(ctx: Context, invocation: CommandInvocation): CommandResult {
  const engine = engineOf(ctx)
  if (engine === undefined) {
    return {
      kind: 'error',
      text: 'The loaded compaction backend is not the autobiographical engine; nothing to toggle.',
    }
  }
  switch (invocation.rawInput.trim().toLowerCase()) {
    case '':
    case 'status':
      return { kind: 'success', text: stateText(engine.isAutomaticFoldingEnabled) }
    case 'on':
      return { kind: 'success', text: stateText(engine.setAutomaticFolding(true)) }
    case 'off':
      return { kind: 'success', text: stateText(engine.setAutomaticFolding(false)) }
    default:
      return { kind: 'error', text: USAGE }
  }
}

/**
 * Register `/autobio` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'autobio',
    description: 'Turn autobiographical memory folding on or off',
    input: { hint: '[on|off|status]' },
    handler: invocation => executeAutobio(ctx, invocation),
  })
}
