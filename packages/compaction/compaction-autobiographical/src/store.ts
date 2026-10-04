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

/**
 * A store record as the library receives it. Chronicle also carries the
 * written item as a serialized `payload`; nothing reads it, and building one
 * would serialize every appended item for no reader (see `LogStore.record`).
 */
export interface StoreRecord {
  id: string
  sequence: number
  recordType: string
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
 *
 * @returns The `SlotKind` registrations for the three seeded slots.
 */
export function slots(): { messages: SlotKind; summaries: SlotKind; counter: SlotKind } {
  return {
    messages: { id: MESSAGES_STATE, strategy: 'append_log' },
    summaries: { id: 'default/autobio:summaries', strategy: 'append_log' },
    counter: { id: 'default/autobio:counter', strategy: 'snapshot' },
  }
}

/**
 * The names the store answers with absence rather than with the thrower below.
 *
 * The library asks about the first three with `typeof` and takes absence as the
 * answer: it skips index registration outright, and the two query names are how
 * it reports a store it cannot run an indexed query against. Answering those
 * with a function makes the store claim a capability it does not have, and the
 * drift thrower then fires from inside the library's own capability check
 * instead of the library's own unsupported-store path.
 *
 * `registerStateFieldIndex` builds the index behind `MessageStore`'s time-range
 * and channel queries. This store holds plain arrays rebuilt from the log on
 * every open, so there is no persisted slot to index; those queries are not on
 * the path that opens, seeds, plans, or folds.
 *
 * `then` and `toJSON` are the same rule for the two probes a value meets
 * outside the library: a `then` runs the thrower on `await store`, and a
 * `toJSON` runs it on `JSON.stringify(store)`.
 */
const PROBED = new Set(['registerStateFieldIndex', 'queryStateIndexRange', 'queryStateIndexEq', 'then', 'toJSON'])

/**
 * The store `ContextManager` sees. Structurally the library's `JsStore`, and one
 * branch forever: a shim rebuilt from the log has exactly one state, so there is
 * no branch to list, switch, or create — divergence is expressed as fold nodes
 * on the surface, and time travel as the log's own replay.
 *
 * The `Proxy` is what makes the boundary honest. Enumerating the unmodelled
 * methods by hand would mean keeping a copy of the library's surface in sync,
 * which is the same job as reading its d.ts and answering wrong when it moves.
 *
 * @returns A store satisfying the library's `JsStore` structurally. Calling any
 * method this backend does not model throws, naming the method.
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

/**
 * The modelled half of the store, wrapped by {@link createStore}.
 *
 * The `Proxy` around an instance of this class answers the rest. Construct one
 * directly only to reach the methods below; the library must be handed the
 * proxied object, or an unmodelled call resolves to `undefined` instead of
 * throwing.
 */
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
   *
   * @param registration - The slot to register. `strategy` selects the storage:
   * `snapshot` holds one value, anything else holds an append log.
   * @throws Error When `registration.id` is already registered.
   */
  registerState(registration: SlotKind): void {
    if (this.registrations.has(registration.id)) throw new Error(`State with id '${registration.id}' already exists`)
    this.registrations.set(registration.id, registration)
    // A slot can be written before it is registered — `setStateJson` stores a
    // snapshot for an id it has never seen. The other kind of storage is cleared
    // here, because a leftover scalar answers every read while appends go to the
    // array beside it, and the two would never meet.
    if (registration.strategy === 'snapshot') {
      this.arrays.delete(registration.id)
      this.scalars.set(registration.id, null)
    } else {
      this.scalars.delete(registration.id)
      this.arrays.set(registration.id, [])
    }
  }

  /**
   * Retune a registered slot's cadence. `ContextManager.open` feature-detects this
   * with `typeof` before calling it, which is why absence has to mean absence
   * rather than reaching the thrower; it exists here so the retune lands on the
   * registration `listStates` reports.
   *
   * @param registration - The slot's registration, carrying the new cadence.
   * Only `id` and `strategy` are stored; cadence fields are ignored, because this
   * store is rebuilt from the log on every open.
   */
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
   *
   * @param stateId - An append-log slot registered with `registerState`. Throws
   * when the slot is unknown or was registered as a snapshot.
   * @param item - The payload to append. Its own identity fields, if any, are
   * kept alongside the assigned ones.
   * @param idField - Field name to carry the assigned record id under.
   * @param sequenceField - Field name to carry the assigned sequence under.
   * @returns The record, whose `.id` and `.sequence` are the assigned pair.
   */
  appendToStateJsonWithIdentity(stateId: string, item: unknown, idField: string, sequenceField: string): StoreRecord {
    const sequence = this.seq++
    const stored = { ...item as Record<string, unknown>, [idField]: recordId(sequence), [sequenceField]: sequence }
    this.array(stateId).push(stored)
    return this.record(stateId, sequence)
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
   *
   * @param stateId - An append-log slot registered with `registerState`.
   * @param item - The payload to append. A payload owning an `id` keeps it; the
   * store's own identity overwrites nothing.
   * @returns The record, whose `.id` is this store's record id and not the
   * payload's.
   */
  appendToStateJson(stateId: string, item: unknown): StoreRecord {
    return this.appendToStateJsonWithIdentity(stateId, item, 'storeId', 'storeSequence')
  }

  /**
   * Replace one entry, in place. Callers hold the live array from `getStateJson`
   * and re-read it as they edit, so this has to mutate that array rather than
   * swap the slot's reference.
   *
   * @param stateId - An append-log slot registered with `registerState`.
   * @param index - Position within that slot to overwrite. The library resolves
   * it from the entry's id before editing, so a position past the end means the
   * caller lost its place: assigning there would leave a hole, or append where
   * the caller meant to replace.
   * @param payload - The entry's new value, as a JSON buffer.
   * @returns The record describing the write.
   * @throws Error When `index` is outside the slot's entries.
   */
  editStateItem(stateId: string, index: number, payload: Buffer): StoreRecord {
    const value = JSON.parse(payload.toString('utf-8')) as unknown
    const entries = this.array(stateId)
    if (index < 0 || index >= entries.length) {
      throw new Error(`LogStore: editStateItem(${stateId}, ${index}) is outside the slot's ${entries.length} entries`)
    }
    entries[index] = value
    return this.record(stateId, this.seq++)
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
   *
   * @param stateId - An append-log slot registered with `registerState`.
   * @param start - First position to remove.
   * @param end - Exclusive end, so `index, index + 1` removes one entry.
   * @returns The record describing the removal.
   * @throws Error When `stateId` is the messages slot.
   */
  redactStateItems(stateId: string, start: number, end: number): StoreRecord {
    if (stateId === MESSAGES_STATE) throw new Error('LogStore: the messages slot is append-only')
    this.array(stateId).splice(start, end - start)
    return this.record(stateId, this.seq++)
  }

  /**
   * Read a slot. For an append-log slot this is the live array and not a copy:
   * `MessageStore` caches the reference and revalidates it against the branch
   * name, `currentSequence`, the write version and the last item's id and
   * sequence, so returning a copy would force a full materialization on every
   * call. An unregistered slot reads as null.
   *
   * @param stateId - The slot to read.
   * @returns The live value: the append log's array, a snapshot's value, or null.
   */
  getStateJson(stateId: string): unknown {
    return this.scalars.has(stateId) ? this.scalars.get(stateId) ?? null : this.arrays.get(stateId) ?? null
  }

  /**
   * A JSON-array buffer over the requested window — the shape the library's
   * feature detection expects for a point lookup that avoids materializing a
   * large append log. Null means empty, which its caller already handles.
   *
   * @param stateId - An append-log slot registered with `registerState`.
   * @param offset - First position in the window.
   * @param limit - Maximum entries in the window.
   * @returns A JSON array buffer over the window, or null when it is empty.
   */
  getStateSlice(stateId: string, offset: number, limit: number): Buffer | null {
    const window = (this.arrays.get(stateId) ?? []).slice(offset, offset + limit)
    return window.length === 0 ? null : Buffer.from(JSON.stringify(window))
  }

  /**
   * The entry count of an append-log slot, without materializing it.
   *
   * @param stateId - The slot to measure.
   * @returns The count, or null when the slot holds no append log.
   */
  getStateLen(stateId: string): number | null {
    return this.arrays.get(stateId)?.length ?? null
  }

  /**
   * One entry of an append-log slot, without materializing the rest.
   * Feature-detected alongside `getStateSlice`, which is why it is present and
   * correct rather than reached through the thrower.
   *
   * @param stateId - An append-log slot registered with `registerState`.
   * @param index - Position of the entry to read.
   * @returns The entry, or null when the slot or the position holds nothing.
   */
  getStateItemJson(stateId: string, index: number): unknown {
    return this.arrays.get(stateId)?.[index] ?? null
  }

  /**
   * Overwrite a whole slot: an append-log slot is rewritten entry for entry, a
   * snapshot slot takes the value directly.
   *
   * @param stateId - The slot to write. An unregistered id registers as a
   * snapshot, which is how `persistPins` stores its object.
   * @param value - The new value, round-tripped through JSON.
   * @returns The record describing the write.
   */
  setStateJson(stateId: string, value: unknown): StoreRecord {
    const stored = canonical(value)
    // An append-log slot is rewritten, never given a scalar: every append-log
    // receiver passes an array, and one that did not would be replacing a log
    // with a value its own reader cannot walk.
    if (this.arrays.has(stateId)) this.arrays.set(stateId, stored as unknown[])
    else this.scalars.set(stateId, stored)
    return this.record(stateId, this.seq++)
  }

  /**
   * Every registered slot, in registration order.
   *
   * @returns The slots' ids and strategies. Cadence fields are not included,
   * because `updateStateStrategy` does not store them.
   */
  listStates(): Array<{ id: string; strategy: string }> {
    return [...this.registrations.values()].map(({ id, strategy }) => ({ id, strategy }))
  }

  /**
   * One branch, and always the same object: the library compares branches by
   * name, so a stable name is what keeps a replay from reading as a branch
   * switch and wiping the token cache, and one object is the simplest way to
   * keep that name stable.
   *
   * @returns The one branch, the same object on every call.
   */
  currentBranch(): { name: string } {
    return this.branch
  }

  /**
   * The head of the log.
   *
   * @returns The sequence of the newest write, or -1 when nothing has been
   * written yet.
   */
  currentSequence(): number {
    return this.seq - 1
  }

  /**
   * Chronicle reclaims persisted log space here. This store holds nothing on
   * disk, so there is nothing to reclaim: the compression-refusal-quarantine
   * ledger is the only caller, and it ignores the return value, so null is safe.
   *
   * @param _stateId - The slot the caller wants compacted. Unused.
   * @returns Always null.
   */
  compactState(_stateId: string): StoreRecord | null {
    return null
  }

  /**
   * Chronicle writes its log to disk here. This store holds nothing on disk, so
   * there is nothing to flush; the library calls it from `ContextManager.sync`.
   */
  sync(): void {
    // Nothing is persisted, so a flush has no work to do.
  }

  /**
   * Chronicle releases its file handle here, and `ContextManager` calls it only
   * when it opened the store itself. This backend always hands its own store in,
   * so the map holding it is the only thing disposal has to drop.
   */
  close(): void {
    // Nothing is held open, so a close has no work to do.
  }

  /**
   * Whether the store has been closed. `ContextManager.isClosed` asks this, and a
   * store that holds nothing open has no closed state to report.
   *
   * @returns Always false.
   */
  isClosed(): boolean {
    return false
  }

  private array(stateId: string): unknown[] {
    const found = this.arrays.get(stateId)
    if (!found) throw new Error(`LogStore: no append-log state "${stateId}" — registerState was never called for it`)
    return found
  }

  /** The record a write reports. The written item is already in the slot, and
   * nothing reads a serialized copy of it, so the record carries the write's
   * identity alone. */
  private record(stateId: string, sequence: number): StoreRecord {
    return {
      id: recordId(sequence),
      sequence,
      recordType: `state:${stateId}`,
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
