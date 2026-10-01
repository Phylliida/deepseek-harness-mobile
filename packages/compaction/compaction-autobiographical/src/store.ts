/**
 * In-memory stand-in for the Chronicle store `ContextManager` normally opens
 * from disk.
 *
 * The session log is the only durable copy of the memory system's history; the
 * store is scratch space rebuilt from that log on every open (see `seed.ts`).
 * So this shim holds slots in plain arrays, and the only writes that reach it
 * are the ones a fold or a compression tick makes during the pass.
 *
 * Three behaviours are load-bearing rather than incidental:
 *
 * - `getStateJson` hands back the live array. `MessageStore` caches that
 *   reference for the whole slot and revalidates it against `currentSequence()`,
 *   so a shim that copied or froze it would silently make every read a full
 *   rebuild — the quadratic ingest that already cost this system an hours-long
 *   wedge.
 * - `currentSequence()` is `counter - 1`: appends assign then increment, so the
 *   head is one behind. A store-global sequence is what the library expects —
 *   it revalidates a foreign append by last-item identity rather than rebuilding
 *   (`message-store.js:1330`).
 * - `currentBranch()` returns one stable object. `MessageStore` wipes its token
 *   cache whenever the branch id changes, so a fresh object per call would be a
 *   performance cliff rather than a visible bug.
 *
 * Reads round-trip through JSON — the serde shape Chronicle returns — because
 * message content is hashed downstream to dedupe compression work, and a warm
 * cache holding hand-built objects would hash differently from a cold cache
 * holding deserialized ones for the same message.
 *
 * Anything the library reaches that this shim does not model throws by name, so
 * an upstream change lands as a stack trace rather than a silent wrong answer.
 * Methods the library **feature-detects** are the opposite case and must be
 * present and correct, because absence reads as "this store cannot do that" and
 * sends it down a full-materialization fallback: `updateStateStrategy`,
 * `getStateSlice`, `getStateItemJson`.
 *
 * Which methods are modelled was decided by enumerating every `store.<method>`
 * call site in the library's `dist/src`, not by reading its d.ts. `getAll`,
 * `getState` and `setState` are not among them: the bare `store` those appear
 * under is a `MessageStore`, which the strategy reaches through
 * `ctx.messageStore`. `createBranchAt`, `switchBranch`, `sync`, `isClosed`,
 * `close`, `treeGet`, `treeSet`, `listBranches` and `getStateJsonAt` are real
 * store calls with no caller on this path — protein divergence is expressed as
 * fold nodes on the surface and time travel as the log's own replay, so nothing
 * forks, syncs, or asks for a message as it stood at an earlier sequence.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/store
 */

import { createHash } from 'node:crypto'

/** One state slot: an append log's entries, or a snapshot's single value. */
interface Slot {
  strategy: string
  items: unknown[]
  snapshot?: unknown
}

/** A record as the library receives it. */
interface StoreRecord {
  id: string
  sequence: number
  recordType: string
  payload: Buffer
  timestamp: number
  causedBy: string[]
  linkedTo: string[]
}

/** A branch as the library receives it. */
interface StoreBranch {
  id: string
  name: string
  head: number
  created: number
}

/** A state registration as the library declares it. */
export interface SlotKind {
  id: string
  strategy: string
}

/**
 * The part of the library's store interface this backend models.
 *
 * Declared here rather than imported from `@animalabs/chronicle` on purpose.
 * `JsStore` is a native class, so it cannot be implemented structurally, and a
 * type-only dependency would still have to be declared in the manifest — putting
 * the package this backend exists to remove back on the graph. The library's own
 * d.ts is the reference if one of these shapes drifts.
 *
 * Only methods with a live caller are here. `sync`, `isClosed` and `close` are
 * not: the library reaches them through `ContextManager.sync`/`isClosed`/`close`,
 * none of which anything calls — and `close` is gated on the manager owning the
 * store, which is false for the store this backend hands it. A caller that
 * appears would rather find the method missing than find a no-op standing in for
 * it, so they are gaps in this interface instead of silent stubs.
 */
export interface ChronicleStore {
  currentBranch(): StoreBranch
  currentSequence(): number
  registerState(registration: SlotKind): void
  updateStateStrategy(registration: SlotKind): void
  getStateJson(stateId: string): unknown
  setStateJson(stateId: string, value: unknown): StoreRecord
  appendToStateJson(stateId: string, item: unknown): StoreRecord
  appendToStateJsonWithIdentity(stateId: string, item: unknown, idField: string, sequenceField: string): StoreRecord
  editStateItem(stateId: string, index: number, payload: Buffer): StoreRecord
  redactStateItems(stateId: string, start: number, end: number): StoreRecord
  getStateLen(stateId: string): number | null
  getStateSlice(stateId: string, offset: number, limit: number): Buffer | null
  getStateItemJson(stateId: string, index: number): unknown
  listStates(): Array<{ id: string; strategy: string }>
  storeBlob(content: Buffer, contentType: string): string
  getBlob(hash: string): Buffer | null
  compactState(stateId: string): StoreRecord | null
}

/** Snapshot slots keep one value; every other slot is an append log. */
const SNAPSHOT = 'snapshot'

/**
 * The slots seeding writes, and the ids the strategy reads them back by.
 *
 * The namespace is the one `ContextManager.open` resolves for a config that
 * carries none (`'default'`), and this backend never passes one. Messages are
 * unnamespaced because the manager is never asked to isolate them. Every other
 * slot the strategy registers is left to the library, which registers it in a
 * try/catch that treats a repeat as success.
 *
 * Snapshot cadence is deliberately absent: a shim rebuilt from the memory log
 * has no snapshot scheduler to steer — `updateStateStrategy` ignores cadence by
 * contract — so carrying those numbers would only be a claim about this store
 * that a library version bump could falsify.
 */
export function slots(): {
  messages: SlotKind
  summaries: SlotKind
  counter: SlotKind
} {
  return {
    messages: { id: MESSAGES_STATE, strategy: 'append_log' },
    summaries: { id: 'default/autobio:summaries', strategy: 'append_log' },
    counter: { id: 'default/autobio:counter', strategy: SNAPSHOT },
  }
}

/** The `messages` slot id, which carries no namespace. */
export const MESSAGES_STATE = 'messages'

/**
 * Capability probes. The library asks whether these exist with `typeof` and
 * takes absence as the answer, so these must resolve to `undefined` rather than
 * to the thrower below — a thrower here would be the shim claiming a capability
 * it does not have, which is exactly what the library's callers are trying to
 * rule out.
 *
 * `registerStateFieldIndex` builds the index that `MessageStore`'s time-range
 * and channel queries use. This store keeps plain arrays in memory and is
 * rebuilt from the log on every open, so there is no persisted slot to index and
 * nothing to keep fresh — and none of those query methods are on the path that
 * opens, seeds, plans, or folds. Their absence is reported clearly by the
 * library itself, which throws a named "unsupported" error rather than
 * degrading into a full scan.
 */
const PROBED = new Set(['registerStateFieldIndex'])

/**
 * The store `ContextManager` sees. Structurally the library's `JsStore`, and one
 * branch forever: a shim rebuilt from the log has exactly one state, so it has no
 * branch to list, switch, or create — protein divergence is expressed as fold
 * nodes on the surface, and time travel as the log's own replay.
 *
 * A `Proxy` is what makes the boundary honest. Every method the library reaches
 * is modelled on the class below; anything else — a branch `treeGet`, a
 * subscription, a `getState` Buffer form it never asks for today — throws by
 * name instead of resolving to `undefined` and reading as "this store cannot do
 * that". Enumerating the unmodelled methods instead would mean keeping a copy of
 * the library's surface in sync by hand, which is the same job as reading its
 * d.ts and answering wrong whenever it moves.
 */
export const createStore = (): LogStore => new Proxy(new LogStore(), {
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver)
    if (value !== undefined || typeof property !== 'string') return value
    if (PROBED.has(property)) return undefined
    return () => {
      throw new Error(
        `LogStore.${property}() called: the context-manager library moved a code path onto it and `
        + 'the log-native store does not model it. Extend store.ts rather than adding a guard.',
      )
    }
  },
})

export class LogStore implements ChronicleStore {
  private readonly slots = new Map<string, Slot>()
  private readonly blobs = new Map<string, Buffer>()
  private readonly branch: StoreBranch = { id: 'main', name: 'main', head: 0, created: 0 }
  private counter = 0

  currentBranch(): StoreBranch {
    return this.branch
  }

  /** Appends assign then increment, so the head is one behind the counter. */
  currentSequence(): number {
    return this.counter - 1
  }

  registerState(registration: SlotKind): void {
    if (this.slots.has(registration.id)) {
      // The library depends on this throwing: `ContextManager.open` catches it
      // and records that the slot was already registered.
      throw new Error(`State with id '${registration.id}' already exists`)
    }
    this.slots.set(registration.id, { strategy: registration.strategy, items: [] })
  }

  /** Feature-detected by `ContextManager.open`, which then calls it. */
  updateStateStrategy(registration: SlotKind): void {
    this.slot(registration.id).strategy = registration.strategy
  }

  appendToStateJsonWithIdentity(stateId: string, item: unknown, idField: string, sequenceField: string): StoreRecord {
    const sequence = this.counter++
    // Neither identity is the caller's to choose, the same way Chronicle assigns
    // them: `ContextLog.append` and `MessageStore.push` both read these two back
    // off the payload rather than off the record. What they are *named* is the
    // caller's to choose, and that is the whole reason this takes field names —
    // the library names them `id` and `sequence` for a message, which has neither
    // of its own, while a `SummaryEntry` supplies both. Splicing a summary's
    // identity under those names would overwrite its recollection id with this
    // store's record id and leave it unreachable by name.
    return this.push(stateId, {
      ...(item as Record<string, unknown>),
      [idField]: recordId(sequence),
      [sequenceField]: sequence,
    }, sequence)
  }

  /**
   * Append with the identity this store assigns, under field names that collide
   * with no payload's own. `ContextLog.append`, `pushSummary` and
   * `appendChunkRecord` all come through here.
   */
  appendToStateJson(stateId: string, item: unknown): StoreRecord {
    return this.appendToStateJsonWithIdentity(stateId, item, 'storeId', 'storeSequence')
  }

  /**
   * Replace one entry, in place. The callers hold the live array from
   * `getStateJson` and re-read it as they edit, so this has to mutate that same
   * array rather than swap the slot's reference.
   */
  editStateItem(stateId: string, index: number, payload: Buffer): StoreRecord {
    const target = this.slot(stateId)
    const value = JSON.parse(payload.toString('utf-8')) as unknown
    target.items[index] = value
    return this.record(stateId, value, this.counter++)
  }

  /** Exclusive end, matching Chronicle: callers pass `index, index + 1`. */
  redactStateItems(stateId: string, start: number, end: number): StoreRecord {
    const target = this.slot(stateId)
    target.items.splice(start, end - start)
    return this.record(stateId, { redacted: [start, end] }, this.counter++)
  }

  getStateLen(stateId: string): number | null {
    return this.slots.get(stateId)?.items.length ?? null
  }

  /**
   * A JSON-array buffer over the requested window — the shape the library's
   * feature detection expects for a point lookup that avoids materializing a
   * large append log. Null means empty, which its caller already handles.
   */
  getStateSlice(stateId: string, offset: number, limit: number): Buffer | null {
    const window = (this.slots.get(stateId)?.items ?? []).slice(offset, offset + limit)
    return window.length === 0 ? null : Buffer.from(JSON.stringify(window))
  }

  /**
   * The live array, deliberately — see the module docstring. A snapshot slot
   * hands back its one value instead.
   */
  getStateJson(stateId: string): unknown {
    const target = this.slots.get(stateId)
    if (!target) return null
    return target.strategy === SNAPSHOT ? target.snapshot ?? null : target.items
  }

  getStateItemJson(stateId: string, index: number): unknown {
    return this.slots.get(stateId)?.items[index] ?? null
  }

  setStateJson(stateId: string, value: unknown): StoreRecord {
    const target = this.slot(stateId)
    const stored = canonical(value)
    // An append-log slot rewrites its entries — that is what the library's
    // `setStateJson` means for one, and writing `snapshot` instead would put the
    // value where `getStateJson` never looks.
    if (target.strategy === SNAPSHOT) target.snapshot = stored
    else target.items = Array.isArray(stored) ? stored : [stored]
    return this.record(stateId, stored, this.counter++)
  }

  listStates(): Array<{ id: string; strategy: string }> {
    return [...this.slots].map(([id, slot]) => ({ id, strategy: slot.strategy }))
  }

  storeBlob(content: Buffer, _contentType: string): string {
    const hash = `blob-${createHash('sha256').update(content).digest('hex')}`
    this.blobs.set(hash, content)
    return hash
  }

  getBlob(hash: string): Buffer | null {
    return this.blobs.get(hash) ?? null
  }

  /** Compaction is Chronicle reclaiming log space. There is no log here. */
  compactState(_stateId: string): StoreRecord | null {
    return null
  }

  private slot(stateId: string): Slot {
    const found = this.slots.get(stateId)
    if (!found) throw new Error(`LogStore: no state "${stateId}" — registerState was never called for it`)
    return found
  }

  private push(stateId: string, value: unknown, sequence: number): StoreRecord {
    this.slot(stateId).items.push(value)
    return this.record(stateId, value, sequence)
  }

  private record(stateId: string, payload: unknown, sequence: number): StoreRecord {
    return {
      id: recordId(sequence),
      sequence,
      recordType: `state:${stateId}`,
      payload: Buffer.from(JSON.stringify(payload)),
      timestamp: Date.now(),
      causedBy: [],
      linkedTo: [],
    }
  }
}

/** Round-trip so a stored entry matches what a later read deserializes. */
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

/** Chronicle identity, close enough to be indistinguishable: unique per sequence. */
function recordId(sequence: number): string {
  return `record-${sequence.toString(16).padStart(12, '0')}`
}
