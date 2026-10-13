import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import * as UserModelInvariant from '../src/invariant.ts'

const selection = { provider: 'anthropic', model: 'claude-opus', prompt: 'Ship the feature' }

/** Append one user-model-sourced reply. */
function appendReply(session: Session, provider = selection.provider, model = selection.model): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'steer' }],
    source: { kind: 'user-model', provider, model },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Mount the store, the invariant registry, and this package's companion. */
async function mount(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(UserModelInvariant)
  const session = ctx.sessions.create(SessionId('user-model-invariant'))
  return { ctx, session }
}

describe('user-model provenance invariants', () => {
  it('accepts a reply matching the armed route', async () => {
    const { session } = await mount()
    session.append('user-model/armed', selection)
    expect(() => { appendReply(session) }).not.toThrow()
    session.append('user-model/disarmed', { reason: 'complete' })
    session.append('user-model/armed', selection)
    expect(() => { appendReply(session) }).not.toThrow()

  })

  it('rejects a reply with no armed selection or a mismatched route', async () => {
    const { session } = await mount()
    expect(() => { appendReply(session) }).toThrow(InvariantError)
    session.append('user-model/armed', selection)
    expect(() => { appendReply(session, 'other', 'route') }).toThrow(/does not match/)

  })

  it('reconstructs existing sessions mounted before the registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('user-model-invariant-early'))
    session.append('user-model/armed', selection)
    session.append('user-model/disarmed', { reason: 'user' })
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(UserModelInvariant)
    expect(() => { appendReply(session) }).toThrow(InvariantError)

  })

  it('ignores human and non-message events', async () => {
    const { session } = await mount()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'human' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  })
})
