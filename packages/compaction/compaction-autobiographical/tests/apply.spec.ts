/**
 * The two small modules that sit at the edges of the engine: defaults, and the
 * precondition a fold has to clear before it is allowed to touch the surface.
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SummaryEntry } from '@animalabs/context-manager'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { applyFold, applyFolds } from '../src/apply.ts'
import { OPERATING_WINDOW_CAP, resolveConfig } from '../src/config.ts'
import { DivergenceError } from '../src/plan.ts'
import type { FoldOp } from '../src/plan.ts'

const ROUTE = { provider: 'test', model: 'test-model' }

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
    coveredNodes: overrides.shadowedSeqs,
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

  // Everything below is refused before the first bracket event reaches the log.
  // The session would refuse these mid-bracket otherwise, and a refused replace
  // leaves a `compaction/start` no `compaction/end` ever closes: the compaction
  // invariant then rejects every later bracket and turn boundary, so the session
  // is wedged for good rather than merely unfolded.
  it('refuses a span naming a node the live surface does not hold', () => {
    const { session, ask, answer } = live()
    const before = session.events.length

    expect(() => applyFold(session, op({ startSeq: ask + 900, endSeq: answer, shadowedSeqs: [ask + 900, answer] }), null, 0, ROUTE))
      .toThrow(DivergenceError)
    expect(session.events.length).toBe(before)
    expect(session.events.filter(event => event.type.startsWith('compaction/'))).toEqual([])
  })

  it('refuses a span that does not cover the nodes the op cites', () => {
    const { session, ask, answer } = live()

    // The session resolves a replacement's range positionally and refuses a range
    // that names a node the op did not cite, so an op whose span and citations
    // disagree is a plan that cannot land.
    expect(() => applyFold(session, op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask], coveredNodes: [ask] }), null, 0, ROUTE))
      .toThrow(/spans 0..1 but covers 0/)
    expect(session.events.filter(event => event.type.startsWith('compaction/'))).toEqual([])
  })

  it('refuses two folds claiming one surface node', () => {
    const { session, ask, answer } = live()
    const before = session.events.length
    const held = op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask, answer] })

    // Two nodes cannot replace one position, so the pair is refused as a batch:
    // the first op's bracket is never opened, which is what keeps the refusal
    // from stranding it.
    expect(() => applyFolds(session, [held, { ...held, summaryId: 'L1-1' }], null, 0, ROUTE))
      .toThrow(/two folds claim surface node/)
    expect(session.events.length).toBe(before)
  })

  it('refuses fold content the session log cannot store', () => {
    const { session, ask, answer } = live()
    const before = session.events.length
    // The strategy keeps whatever the provider streamed and the fold replays it
    // verbatim, so a captured carrier is the one part of a fold this package does
    // not build. The log accepts lossless JSON only, and the refusal has to happen
    // before the bracket opens for the same reason as the range refusals.
    const captured = [{
      type: 'reasoning',
      text: 'private thinking',
      signature: { unserializable: true, toJSON: undefined, render: () => 'x' },
    }] as unknown as ContentBlock[]
    const held = { ...op({ startSeq: ask, endSeq: answer, shadowedSeqs: [ask, answer] }) }

    expect(() => applyFold(session, {
      ...held,
      summary: { ...held.summary, responseContent: captured as never },
    }, null, 0, ROUTE)).toThrow(/content the session log cannot store/)
    expect(session.events.length).toBe(before)
  })
})
