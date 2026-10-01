/**
 * The two small modules that sit at the edges of the engine: defaults, and the
 * precondition a fold has to clear before it is allowed to touch the surface.
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SummaryEntry } from '@animalabs/context-manager'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { applyFold } from '../src/apply.ts'
import { OPERATING_WINDOW_CAP, resolveConfig } from '../src/config.ts'
import type { FoldOp } from '../src/plan.ts'

/** A session holding one user and one assistant append. */
function live(): { session: Session; ask: number; answer: number } {
  const session = Session.create(SessionId('apply-spec'))
  const ask = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'ask' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  const answer = session.append('assistant/message', {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'answer' }],
      source: { provider: 'test', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' }).seq
  return { session, ask, answer }
}

/** A fold op over the given span, citing whichever seqs the case needs. */
function op(overrides: Partial<FoldOp> & Pick<FoldOp, 'startSeq' | 'endSeq' | 'shadowedSeqs'>): FoldOp {
  return {
    summaryId: 'L1-0',
    level: 1,
    shadowedTokens: 10,
    // The cases that care about surface order set this; the rest fold the
    // log-seq order, where position and seq agree.
    span: { from: overrides.startSeq, to: overrides.endSeq },
    summary: {
      id: 'L1-0',
      level: 1,
      content: 'the ground',
      tokens: 3,
      created: 1,
      sourceLevel: 0,
      sourceIds: [],
      sourceRange: { first: '', last: '' },
    } satisfies SummaryEntry,
    ...overrides,
  }
}

describe('resolveConfig', () => {
  it('defaults the operating window to the cap', () => {
    const resolved = resolveConfig({})

    expect(resolved).toEqual({
      operatingWindowTokens: OPERATING_WINDOW_CAP,
      reserveTokens: 8192,
      auto: true,
      strategy: {},
    })
  })

  it('carries a caller\'s window and knobs through unchanged', () => {
    expect(resolveConfig({
      operatingWindowTokens: 12_000,
      reserveTokens: 256,
      auto: false,
      strategy: { speculativeProduction: true },
    })).toEqual({
      operatingWindowTokens: 12_000,
      reserveTokens: 256,
      auto: false,
      strategy: { speculativeProduction: true },
    })
  })
})

describe('applyFold', () => {
  it('lands one balanced bracket carrying the fold\'s own id', () => {
    const { session, ask, answer } = live()

    const result = applyFold(session, op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask, answer] }), 2, 1, { provider: 'test', model: 'test-model' })

    const types = session.events.map(event => event.type)
    expect(types.slice(-4)).toEqual(['compaction/start', 'compaction/summary', 'assistant/message', 'compaction/end'])
    expect(result.compactionId).toBe('autobio:L1-0')
    // The node identifies the recollection it stands for without parsing prose.
    const node = session.surface.nodes.at(-1)
    expect(node).toBe(session.events.at(-2)?.seq)
  })

  it('lands the fold on turn zero when the session has no current turn', () => {
    const { session, ask, answer } = live()

    // `currentTurn` answers null before the first `turn/start`; the node still
    // has to carry a turn, and zero is the one the protocol starts from.
    applyFold(session, op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask, answer] }), null, 0, { provider: 'test', model: 'test-model' })

    const node = session.events.find(event => event.type === 'assistant/message')
    expect(node?.type === 'assistant/message' && node.data.turn).toBe(0)
  })

  // The two refusals below belong to the session, which resolves a replacement's
  // range positionally against its own live surface and refuses a range that
  // names a node the op did not cite. Applying does not re-prove either, so these
  // pin that the session still catches them.
  it('refuses a range that does not resolve on the live surface', () => {
    const { session, ask, answer } = live()
    const before = session.surface.nodes.length

    expect(() => applyFold(session, op({ startSeq: ask + 900, endSeq: answer, shadowedSeqs: [] }), null, 0, { provider: 'test', model: 'test-model' }))
      .toThrow(/not found in surface/)
    // The refusal comes from the replacement node, so the bracket and the
    // metered summary are already down. What must not exist is the node itself:
    // no node landed, so the surface is exactly as it was.
    expect(session.surface.nodes.length).toBe(before)
  })

  it('refuses a range that would silently swallow an uncited node', () => {
    const { session, ask, answer } = live()

    expect(() => applyFold(session, op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask] }), null, 0, { provider: 'test', model: 'test-model' }))
      .toThrow(new RegExp(`must include every shadowed surface node; missing ${answer}`))
  })
})
