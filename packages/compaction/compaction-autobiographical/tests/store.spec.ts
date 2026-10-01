/**
 * The log-native store: its own contract, and the one integration that matters —
 * `ContextManager` opening a seeded `LogStore` and reading a real session back
 * out of it.
 */

import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { seedFromLog } from '../src/seed.ts'
import { createStore, LogStore, MESSAGES_STATE, slots } from '../src/store.ts'

/** A session holding `turns` exchanges, shaped the way the harness writes them. */
function transcript(turns: number): Session {
  const session = Session.create(SessionId(`store-spec-${turns}`))
  for (let turn = 0; turn < turns; turn++) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `ask ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${turn}` }],
        source: { provider: 'test', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session
}

/** A seeded store and the session it was replayed from. */
function seeded(turns: number): { store: LogStore; session: Session } {
  const store = new LogStore()
  const session = transcript(turns)
  seedFromLog(store, session)
  return { store, session }
}

/** A store holding only the message slot, for the standalone contract tests. */
function empty(): LogStore {
  const store = new LogStore()
  store.registerState(slots().messages)
  return store
}

describe('LogStore', () => {
  it('hands back the live array so the library caches a reference rather than a copy', () => {
    const { store } = seeded(2)
    const first = store.getStateJson(MESSAGES_STATE)
    expect(store.getStateJson(MESSAGES_STATE)).toBe(first)
    const before = (first as unknown[]).length
    store.appendToStateJson(MESSAGES_STATE, { participant: 'user', content: [] })
    expect((first as unknown[]).length).toBe(before + 1)
  })

  it('counts the sequence down to the head of the log', () => {
    const store = new LogStore()
    expect(store.currentSequence()).toBe(-1)
    store.registerState(slots().counter)
    store.setStateJson(slots().counter.id, 1)
    expect(store.currentSequence()).toBe(0)
  })

  it('gives one stable branch, because a new id per call wipes the token cache', () => {
    const store = new LogStore()
    expect(store.currentBranch()).toBe(store.currentBranch())
  })

  it('throws on a repeated registration, which is how the library detects one', () => {
    const store = new LogStore()
    store.registerState(slots().counter)
    expect(() => { store.registerState(slots().counter) }).toThrow(/already exists/)
  })

  it('retunes a slot via updateStateStrategy, which is feature-detected', () => {
    const { store } = seeded(1)
    store.updateStateStrategy({ ...slots().summaries, strategy: 'append_log' })
    expect(store.listStates()).toContainEqual({ id: slots().summaries.id, strategy: 'append_log' })
  })

  it('round-trips reads through JSON so a warm cache hashes like a cold one', () => {
    const store = empty()
    const written = { nested: { at: 'x' }, list: [1, 2] }
    store.appendToStateJson(MESSAGES_STATE, { participant: 'user', content: [], extra: written })
    const read = (store.getStateJson(MESSAGES_STATE) as Array<{ extra: unknown }>)[0]?.extra
    expect(read).toEqual(written)
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
  })

  it('assigns the identity its append-log writers cite back', () => {
    const { store } = seeded(1)
    const record = store.appendToStateJson(slots().summaries.id, { content: 'x' })
    const stored = JSON.parse(String(record.payload)) as { storeId: string; storeSequence: number }
    expect(stored.storeId).toBe(record.id)
    expect(stored.storeSequence).toBe(record.sequence)
  })

  it('leaves a payload\'s own identity alone, because a recollection is named by it', () => {
    const { store } = seeded(1)
    store.appendToStateJson(slots().summaries.id, { id: 'L1-0', content: 'x' })
    const [entry] = store.getStateJson(slots().summaries.id) as Array<{ id: string; storeId: string }>
    // Both survive: `L1-0` is the recollection's name, `storeId` its log position.
    expect(entry).toMatchObject({ id: 'L1-0', storeId: expect.stringMatching(/^record-\d{12}$/) })
  })

  it('edits an entry in place, because its callers hold the live array', () => {
    const { store } = seeded(1)
    const live = store.getStateJson(MESSAGES_STATE) as unknown[]
    store.editStateItem(MESSAGES_STATE, 0, Buffer.from(JSON.stringify({ participant: 'system' })))
    expect(store.getStateJson(MESSAGES_STATE)).toBe(live)
    expect((live[0] as { participant: string }).participant).toBe('system')
  })

  it('refuses to redact the messages slot, whose ids are surface positions', () => {
    const store = empty()
    for (const seq of [1, 2, 3]) store.appendToStateJson(MESSAGES_STATE, { seq })
    expect(() => store.redactStateItems(MESSAGES_STATE, 0, 1)).toThrow(/append-only/)
    expect(store.getStateLen(MESSAGES_STATE)).toBe(3)
  })

  it('treats the redaction end as exclusive', () => {
    const store = empty()
    store.registerState(slots().summaries)
    for (const seq of [1, 2, 3]) store.appendToStateJson(slots().summaries.id, { seq })
    store.redactStateItems(slots().summaries.id, 0, 1)
    expect(store.getStateLen(slots().summaries.id)).toBe(2)
    expect((store.getStateJson(slots().summaries.id) as Array<{ seq: number }>).map(item => item.seq)).toEqual([2, 3])
  })

  it('serves a point lookup as a JSON array buffer, and null when empty', () => {
    const { store } = seeded(1)
    const slice = store.getStateSlice(MESSAGES_STATE, 0, 1)
    expect(JSON.parse(slice?.toString('utf-8') ?? 'null')).toEqual([expect.objectContaining({ participant: 'user' })])
    expect(store.getStateSlice(MESSAGES_STATE, 99, 1)).toBeNull()
    expect(store.getStateItemJson(MESSAGES_STATE, 99)).toBeNull()
  })

  it('leaves inline media alone, so a session with an image seeds without a blob store', () => {
    const store = empty()
    const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGk=' } }
    store.appendToStateJson(MESSAGES_STATE, { participant: 'user', content: [image] })
    const [stored] = store.getStateJson(MESSAGES_STATE) as Array<{ content: unknown[] }>
    expect(stored?.content).toEqual([image])
  })

  it('names the slot when a write races ahead of its registration', () => {
    const store = new LogStore()
    expect(() => store.appendToStateJson('unregistered', {})).toThrow(/no append-log state "unregistered"/)
  })

  it('rewrites an append-log slot through setStateJson, since that slot has no single value', () => {
    const { store } = seeded(1)
    store.setStateJson(MESSAGES_STATE, [{ participant: 'user', content: [] }])
    expect(store.getStateLen(MESSAGES_STATE)).toBe(1)
  })

  it('reports a fresh slot as empty rather than missing', () => {
    const store = new LogStore()
    expect(store.getStateLen(MESSAGES_STATE)).toBeNull()
    expect(store.getStateSlice(MESSAGES_STATE, 0, 10)).toBeNull()
    expect(store.getStateItemJson(MESSAGES_STATE, 0)).toBeNull()
    expect(store.getStateJson(MESSAGES_STATE)).toBeNull()
  })

  it('compacts a slot without reclaiming anything, because there is no log', () => {
    const { store } = seeded(2)
    expect(store.compactState(MESSAGES_STATE)).toBeNull()
    expect(store.getStateLen(MESSAGES_STATE)).toBeGreaterThan(0)
  })

  it('retunes a populated slot without disturbing its entries', () => {
    const store = new LogStore()
    const ids = slots()
    store.registerState(ids.messages)
    const written = store.appendToStateJson(ids.messages.id, { participant: 'user' })
    // Retuning is the supported way to reach a slot a second time, and it leaves
    // the entries alone — a retune is not a re-registration.
    store.updateStateStrategy(ids.messages)
    expect(store.getStateJson(ids.messages.id)).toEqual([expect.objectContaining({ storeId: written.id })])
  })
})

describe('ContextManager over a seeded LogStore', () => {
  const strategy = () => new AutobiographicalStrategy({})

  it('opens against the shim and reads the replayed session back out', async () => {
    const { store } = seeded(3)
    const manager = await ContextManager.open({ store: store as never, strategy: strategy() })

    // Three turns of one ask and one answer each, as the shim holds them.
    const replayed = store.getStateLen(MESSAGES_STATE)
    expect(replayed).toBe(6)
    expect(manager.getMessageCount()).toBe(replayed)
    const window = manager.getMessageWindow(0, 2)
    expect(window.messages.map(message => message.participant)).toEqual(['user', 'assistant'])
    expect(window.messages[0]?.content).toEqual([{ type: 'text', text: 'ask 0' }])
    manager.close()
  })

  it('keeps adding through the manager readable at the same slot', async () => {
    const { store } = seeded(2)
    const manager = await ContextManager.open({ store: store as never, strategy: strategy() })
    const before = manager.getMessageCount()
    const id = manager.addMessage('user', [{ type: 'text', text: 'live' }])
    expect(manager.getMessageCount()).toBe(before + 1)
    expect(manager.getMessage(id)).toEqual(expect.objectContaining({ participant: 'user' }))
    manager.close()
  })

  it('compiles a layout from the seeded session', async () => {
    const { store } = seeded(4)
    const manager = await ContextManager.open({ store: store as never, strategy: strategy() })
    const compiled = await manager.compile({ maxTokens: 4096, reserveForResponse: 512 })
    expect(compiled.messages.length).toBeGreaterThan(0)
    manager.close()
  })

  it('produces the same store contents on a second replay of the same log', () => {
    const session = transcript(3)
    const first = new LogStore()
    const second = new LogStore()
    seedFromLog(first, session)
    seedFromLog(second, session)
    expect(second.getStateJson(MESSAGES_STATE)).toEqual(first.getStateJson(MESSAGES_STATE))
    expect(second.getStateJson(slots().counter.id)).toEqual(first.getStateJson(slots().counter.id))
  })
})

describe('the guard on unmodelled store methods', () => {
  it('throws by name when the library reaches a method the shim does not model', () => {
    // The unmodelled names are deliberately absent from `LogStore`, which is what
    // makes the guard fire; the cast is how the test reaches one anyway.
    const store = createStore() as unknown as Record<string, (...args: unknown[]) => unknown>
    expect(() => store['createBranchAt']?.('x', 'main', 0)).toThrow(/LogStore\.createBranchAt\(\) called/)
    expect(() => store['treeGet']?.('x', 'k')).toThrow(/Extend store\.ts/)
  })

  it('answers a capability probe with absence, so the library keeps its fallback', () => {
    const store = createStore() as unknown as Record<string, unknown>
    // `MessageStore` probes this with `typeof` and skips registration when it is
    // missing; a thrower here would fail every open on a real session.
    expect(typeof store['registerStateFieldIndex']).not.toBe('function')
  })

  it('leaves the modelled surface alone', () => {
    const store = createStore()
    expect(typeof store.getStateJson).toBe('function')
    expect(typeof store.editStateItem).toBe('function')
  })
})
