/**
 * In-memory stand-in for the Chronicle store `ContextManager` normally opens
 * from disk.
 *
 * The session log is the only durable copy of the memory system's history; this
 * store is scratch space rebuilt from that log on every open (see `seed.ts`). It
 * holds slots in plain maps, and the only writes that reach it are the ones a
 * fold or a compression tick makes during the pass.
 *
 * Everything not modelled throws by name (see `createStore`). That throw is the
 * upstream-drift alarm: a library version that starts reaching for a method this
 * backend does not have should land as a stack trace, not a silent wrong answer.
 *
 * Reads round-trip through JSON, and `getStateJson` hands back the live array —
 * `MessageStore` caches that reference and revalidates it rather than rebuilding,
 * so a copy would turn every read into a full materialization.
 *
 * Media has no blob store here. `MessageStore.append` does run content through
 * `BlobManager.extractBlobs`, but that leaves an inline `base64` image alone
 * rather than writing a `blob_ref` and calling `storeBlob`, so the bytes the
 * session log already holds are the bytes the library reads back. Modelling
 * `storeBlob`/`getBlob` would be inventing a second copy of data nothing
 * consults; if a library version starts minting refs, the throw below names it.
 *
 * @module @deepseek-ai/dsh-compaction-autobiographical/store
 */

/** One state registration, as the library declares it. Cadence fields are ignored. */
export interface SlotKind {
  id: string
  strategy: string
}

/** A store record as the library receives it. */
export interface StoreRecord {
  id: string
  sequence: number
  recordType: string
  payload: Buffer
  timestamp: number
  causedBy: string[]
  linkedTo: string[]
}

/** The `messages` slot id, which carries no namespace. */
export const MESSAGES_STATE = 'messages'

/**
 * The slots seeding writes, and the ids the strategy reads them back by.
 *
 * The namespace is the one `ContextManager.open` resolves for a config carrying
 * none (`'default'`), as this backend never passes one. Messages are unnamespaced
 * because the manager is never asked to isolate them. Every other slot the
 * strategy registers itself, in a try/catch that treats a repeat as success, so
 * only the seeded three are named here.
 */
export function slots(): { messages: SlotKind; summaries: SlotKind; counter: SlotKind } {
  return {
    messages: { id: MESSAGES_STATE, strategy: 'append_log' },
    summaries: { id: 'default/autobio:summaries', strategy: 'append_log' },
    counter: { id: 'default/autobio:counter', strategy: 'snapshot' },
  }
}

/**
 * Capability probes. The library asks whether these exist with `typeof` and
 * takes absence as the answer, so these must resolve to `undefined` rather than
 * to the thrower below — a thrower would be this store claiming a capability it
 * does not have, which is exactly what the library is trying to rule out.
 *
 * `registerStateFieldIndex` builds the index behind `MessageStore`'s time-range
 * and channel queries. This store holds plain arrays rebuilt from the log on
 * every open, so there is no persisted slot to index; those queries are not on
 * the path that opens, seeds, plans, or folds.
 */
const PROBED = new Set(['registerStateFieldIndex'])

/**
 * The store `ContextManager` sees. Structurally the library's `JsStore`, and one
 * branch forever: a shim rebuilt from the log has exactly one state, so there is
 * no branch to list, switch, or create — divergence is expressed as fold nodes
 * on the surface, and time travel as the log's own replay.
 *
 * The `Proxy` is what makes the boundary honest. Enumerating the unmodelled
 * methods by hand would mean keeping a copy of the library's surface in sync,
 * which is the same job as reading its d.ts and answering wrong when it moves.
 */
export const createStore = (): LogStore => new Proxy(new LogStore(), {
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver)
    if (value !== undefined || typeof property !== 'string') return value
    if (PROBED.has(property)) return undefined
    return () => {
      throw new Error(`LogStore.${property}() called: the context-manager library moved a code path onto it and the log-native store does not model it. Extend store.ts rather than adding a guard.`)
    }
  },
})

export class LogStore {
  private readonly registrations = new Map<string, SlotKind>()
  private readonly arrays = new Map<string, unknown[]>()
  private readonly scalars = new Map<string, unknown>()
  private readonly branch = { name: 'main' }
  /** Next append position. A message's `sequence` field is this position, because
   * the library resolves messages by it. */
  private seq = 0

  /**
   * Throws when the slot already exists, because the library depends on that:
   * `registerStates` wraps every call in a try/catch that treats a repeat as
   * success.
   *
   * Nothing refuses a `tree` slot, which the library reserves for
   * `mint-preimage`'s envelope index — a code path that reaches `storeBlob`
   * first, and that this store answers with a throw. Such a slot would land in
   * `arrays` and answers no query anyway, so a guard here would be unreachable.
   */
  registerState(registration: SlotKind): void {
    if (this.registrations.has(registration.id)) throw new Error(`State with id '${registration.id}' already exists`)
    this.registrations.set(registration.id, registration)
    if (registration.strategy === 'snapshot') this.scalars.set(registration.id, null)
    else this.arrays.set(registration.id, [])
  }

  /** Feature-detected by `ContextManager.open`, which then calls it to retune a slot. */
  updateStateStrategy(registration: SlotKind): void {
    this.registrations.set(registration.id, registration)
  }

  /**
   * Append with the identity this store assigns, under field names the caller
   * chooses.
   *
   * The callers read both fields back off the payload rather than off the
   * record: `ContextLog.append` and `MessageStore.push` expect `id` and
   * `sequence`, which a message has none of its own, while the compression
   * quarantine ledger names them `eventId` and `sequence` and takes them off the
   * returned record. Because the ids are assigned ordinals, replaying the same
   * log reproduces the same ids on every open — which is what lets a seeded
   * summary's `sourceRange` point at messages a later seed re-creates.
   */
  appendToStateJsonWithIdentity(stateId: string, item: unknown, idField: string, sequenceField: string): StoreRecord {
    const sequence = this.seq++
    const stored = { ...item as Record<string, unknown>, [idField]: recordId(sequence), [sequenceField]: sequence }
    this.array(stateId).push(stored)
    return this.record(stateId, stored, sequence)
  }

  /**
   * Append a payload that already carries its own identity — a message, a chunk
   * record, a `SummaryEntry`.
   *
   * This deliberately assigns under field names no payload uses, rather than
   * delegating to `('id', 'sequence')` as the implementation doc sketches. A
   * summary is named `L1-0`, and the library matches persisted summaries by
   * `item.id === entry.id` (`autobiographical.ts:3649`, which warns and drops the
   * merge state when it misses); splicing under `id` would overwrite that name
   * with this store's record id and leave `setMergedInto` unable to find its own
   * entry — the duplicate-id divergence four summaries were lost to.
   */
  appendToStateJson(stateId: string, item: unknown): StoreRecord {
    return this.appendToStateJsonWithIdentity(stateId, item, 'storeId', 'storeSequence')
  }

  /**
   * Replace one entry, in place. Callers hold the live array from `getStateJson`
   * and re-read it as they edit, so this has to mutate that array rather than
   * swap the slot's reference.
   */
  editStateItem(stateId: string, index: number, payload: Buffer): StoreRecord {
    const value = JSON.parse(payload.toString('utf-8')) as unknown
    this.array(stateId)[index] = value
    return this.record(stateId, value, this.seq++)
  }

  /**
   * Exclusive end, matching Chronicle: callers pass `index, index + 1`.
   *
   * Redacting the `messages` slot is a structural bug rather than a
   * compaction: message ids *are* positions, so removing one slides every later
   * id out from under the summaries that cite it. Nothing redacts it —
   * `ContextManager.removeMessage` and `removeMessages` are the only callers and
   * none in this repo reaches them — so this throw is what would name the
   * library moving a redaction path onto the messages slot.
   */
  redactStateItems(stateId: string, start: number, end: number): StoreRecord {
    if (stateId === MESSAGES_STATE) throw new Error('LogStore: the messages slot is append-only')
    this.array(stateId).splice(start, end - start)
    return this.record(stateId, { redacted: [start, end] }, this.seq++)
  }

  /** The live array, deliberately — see the module docstring. */
  getStateJson(stateId: string): unknown {
    return this.scalars.has(stateId) ? this.scalars.get(stateId) ?? null : this.arrays.get(stateId) ?? null
  }

  /**
   * A JSON-array buffer over the requested window — the shape the library's
   * feature detection expects for a point lookup that avoids materializing a
   * large append log. Null means empty, which its caller already handles.
   */
  getStateSlice(stateId: string, offset: number, limit: number): Buffer | null {
    const window = (this.arrays.get(stateId) ?? []).slice(offset, offset + limit)
    return window.length === 0 ? null : Buffer.from(JSON.stringify(window))
  }

  getStateLen(stateId: string): number | null {
    return this.arrays.get(stateId)?.length ?? null
  }

  /** Feature-detected alongside `getStateSlice`, which is why it is present and correct. */
  getStateItemJson(stateId: string, index: number): unknown {
    return this.arrays.get(stateId)?.[index] ?? null
  }

  setStateJson(stateId: string, value: unknown): StoreRecord {
    const stored = canonical(value)
    // An append-log slot is rewritten, never given a scalar: every append-log
    // receiver passes an array, and one that did not would be replacing a log
    // with a value its own reader cannot walk.
    if (this.arrays.has(stateId)) this.arrays.set(stateId, stored as unknown[])
    else this.scalars.set(stateId, stored)
    return this.record(stateId, stored, this.seq++)
  }

  listStates(): Array<{ id: string; strategy: string }> {
    return [...this.registrations.values()].map(({ id, strategy }) => ({ id, strategy }))
  }

  /**
   * One branch, and always the same object: callers compare it by identity, and
   * a fresh object per call would read as a branch switch and wipe the token
   * cache.
   */
  currentBranch(): { name: string } {
    return this.branch
  }

  /** The head of the log — -1 when nothing has been written. */
  currentSequence(): number {
    return this.seq - 1
  }

  /** Compaction is Chronicle reclaiming log space. There is no log here. */
  compactState(_stateId: string): StoreRecord | null {
    return null
  }

  private array(stateId: string): unknown[] {
    const found = this.arrays.get(stateId)
    if (!found) throw new Error(`LogStore: no append-log state "${stateId}" — registerState was never called for it`)
    return found
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

/** Chronicle identity, close enough to sort and to read: unique per sequence. */
function recordId(sequence: number): string {
  return `record-${sequence.toString(16).padStart(12, '0')}`
}
