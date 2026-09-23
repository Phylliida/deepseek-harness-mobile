import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AutobiographicalCompactionEngine from '@deepseek-ai/dsh-compaction-autobiographical'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal

/** Adapter answering every memory-formation call with a fixed recollection. */
class RecollectingAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    const text = 'I recall the earlier exchange about lorem ipsum.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function conversation(turns: number): Session {
  const session = Session.create(SessionId(`autobio-${turns}`))
  const filler = 'lorem ipsum dolor sit amet '.repeat(8)
  for (let turn = 1; turn <= turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${filler} question ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${filler} answer ${turn}` }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

describe('AutobiographicalCompactionEngine', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function setup(storeRoot?: string) {
    const root = storeRoot ?? mkdtempSync(join(tmpdir(), 'autobio-test-'))
    roots.push(root)
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    const adapter = new RecollectingAdapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const engine = new AutobiographicalCompactionEngine(ctx, {
      storeRoot: root,
      contextWindowTokens: 400,
      reserveTokens: 100,
      recentWindowTokens: 120,
      headWindowTokens: 0,
      targetChunkTokens: 60,
      mergeThreshold: 2,
      auto: false,
    })
    void llm
    return { ctx, engine, adapter }
  }

  it('folds aged history into an assistant recollection node', async () => {
    const { engine, adapter } = setup()
    const session = conversation(12)
    const agent = { session, options: { provider: 'test', model: 'test-model' } } as Agent

    // Compression runs one chunk per background tick; fold passes apply what
    // The synchronous catch-up converges inside one pass: the picker finds no
    // fitting layout, memory formation runs on the call thread until it does,
    // and the fold lands before the pass returns.
    const result = await engine.compactIfNeeded(agent, 'pressure', SIGNAL)

    expect(adapter.calls).toBeGreaterThan(0)
    expect(result).not.toBeNull()
    // Each tick that formed memory logged its stats snapshot for the chat row.
    const memoryEvents = session.events.filter(event => event.type === 'autobio/memory')
    expect(memoryEvents.length).toBeGreaterThan(0)
    // A tick that mints a recollection carries it so the chat row can disclose it.
    const minted = memoryEvents.find(event => event.data.memory !== undefined)
    expect(minted?.data.memory?.id).toMatch(/^L1-\d+$/)
    expect(minted?.data.memory?.content.length).toBeGreaterThan(0)
    // The mint is stamped with the call attempt that produced it, so the chat
    // folds the call's streamed text and its recollection into one row.
    expect(minted?.data.attempt).toBeGreaterThanOrEqual(1)

    const surfaceTexts = session.deriveMessages()
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
    expect(surfaceTexts.some(text => text.includes('[Recall L1-'))).toBe(true)
    expect(surfaceTexts.some(text => text.includes('I recall the earlier exchange'))).toBe(true)

    // The record is append-only: the folded originals remain in the log.
    const loggedUsers = session.events.filter(event => event.type === 'user/message')
    expect(loggedUsers.length).toBe(12)
    // ...and the fold rode the seam's durable bracket events.
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(true)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
    expect(session.events.some(event => event.type === 'compaction/end')).toBe(true)
    // The fold node carries the compactionId on its model source so the chat
    // timeline can correlate it with the lifecycle and render the marker.
    const fold = session.events.find(event =>
      event.type === 'assistant/message'
      && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
    if (fold?.type !== 'assistant/message') throw new Error('fold node missing')
    const summary = session.events.find(event => event.type === 'compaction/summary')
    expect(fold.data.message.source).toMatchObject({
      kind: 'model',
      compactionId: summary?.data.compactionId,
    })
  }, 30_000)

  it('keeps the verbatim tail out of folded regions', async () => {
    const { engine } = setup()
    const session = conversation(12)
    const agent = { session, options: { provider: 'test', model: 'test-model' } } as Agent

    for (let pass = 0; pass < 40; pass++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    }

    const texts = session.deriveMessages()
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
    // The most recent exchange stays verbatim on the surface.
    expect(texts.some(text => text.includes('question 12'))).toBe(true)
    expect(texts.some(text => text.includes('answer 12'))).toBe(true)
  }, 30_000)

  it('rejects explicit region compaction', async () => {
    const { engine } = setup()
    const session = conversation(2)
    const agent = { session, options: {} } as Agent
    await expect(engine.compactRegion(0, 1, agent)).rejects.toThrow('automatically')
  })

  it('resumes from the on-disk store across engine restarts', async () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'autobio-test-'))
    roots.push(storeRoot)
    const first = setup(storeRoot)
    const session = conversation(12)
    const agent = { session, options: { provider: 'test', model: 'test-model' } } as Agent
    let folded = null
    for (let pass = 0; pass < 40 && folded === null; pass++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      folded = await first.engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    }
    expect(folded).not.toBeNull()
    first.ctx.emit('agent/disposed', { agent })
    await new Promise(resolve => setTimeout(resolve, 50))

    // A harness restart: a fresh engine over the same store reopens the
    // archive; the mirror watermark keeps the old messages from re-entering.
    const second = setup(storeRoot)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'one more question after restart' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    for (let pass = 0; pass < 20; pass++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await second.engine.compactIfNeeded(agent, 'pressure', SIGNAL)
    }
    // The restarted engine compressed at most the newly mirrored chunks —
    // the archive kept the first engine's work, and the existing fold stands.
    expect(second.adapter.calls).toBeLessThanOrEqual(2)
    const texts = session.deriveMessages()
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
    expect(texts.some(text => text.includes('[Recall L1-'))).toBe(true)
  }, 30_000)
})
