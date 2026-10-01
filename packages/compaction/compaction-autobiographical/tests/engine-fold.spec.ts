/**
 * The log-native engine end to end: a real `ContextManager` over a seeded
 * `LogStore`, a real session log, and folding passes driven through the
 * compaction service. What these cases pin is the property the split store could
 * not hold — everything a recollection needs survives in the log, so a restart
 * replays it instead of paying a model to remember again.
 */

import { Context } from '@deepseek-ai/cordis'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import AutobiographicalCompactionEngine from '../src/index.ts'
import { build, settle } from './harness.ts'

/**
 * The transcript messages the log appended to the surface, before any fold.
 * `surfaceOp` is mandatory only on a surface-eligible event, so the guard is
 * what narrows the union.
 */
function appended(session: Session): readonly number[] {
  return session.events.flatMap(event => isAppendSurfaceEvent(event) ? [event.seq] : [])
}

describe('AutobiographicalCompactionEngine', () => {
  it('folds aged history into log-held recollections', async () => {
    const { engine, calls, session, agent } = build(30, 'engine-folds')
    const { result, folds } = await settle(engine, agent)

    expect(result).not.toBeNull()
    expect(folds.length).toBeGreaterThan(0)
    expect(calls.length).toBeGreaterThan(0)

    // The fold node carries the recollection and replaces the ground it covers.
    const node = session.surface.nodes.at(-1)
    expect(node).toBeGreaterThan(0)
    expect(session.events.find(event => event.seq === node)?.type).toBe('assistant/message')
    expect(folds.at(-1)?.shadowedSeqs.length).toBeGreaterThan(1)

    // Nothing fell out of the log: every message the transcript appended is
    // either still on the surface or named by a fold that stands for it.
    const shadowed = new Set(folds.flatMap(fold => fold.shadowedSeqs))
    const unaccounted = appended(session).filter(seq => !shadowed.has(seq) && !session.surface.nodes.includes(seq))
    expect(unaccounted).toEqual([])
  })

  it('replays the log on restart without forming memory again', async () => {
    const { engine, calls, session, agent } = build(30, 'engine-restart')
    await settle(engine, agent)
    const formed = session.events.filter(event => event.type === 'autobio/memory').length
    const compressed = calls.reduce((total, call) => total + call.messages.length, 0)
    expect(formed).toBeGreaterThan(0)

    // A fresh engine over the same log: no archive, no checkpoint. The pyramid
    // has to come back from the replay, so the restart spends no model call.
    const restarted = new AutobiographicalCompactionEngine(new Context(), {
      operatingWindowTokens: 700,
      reserveTokens: 128,
      auto: false,
      strategy: { recentWindowTokens: 0 },
    })
    expect(await restarted.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(calls.reduce((total, call) => total + call.messages.length, 0)).toBe(compressed)
    expect(session.events.filter(event => event.type === 'autobio/memory').length).toBe(formed)
  })
})
