# Log-native Connectome: implementation detail

Companion to [`CONNECTOME-LOG-NATIVE-PLAN.md`](CONNECTOME-LOG-NATIVE-PLAN.md)
(the *why*). This doc is the *what*: module layout, call points, and the shape
of each piece, as built. Where the build diverged from the sketch this doc
started as, the text below is the built form; the pseudocode blocks keep their
original shape only where the code still matches it.

Conventions below: `session` is a DSH `Session`; `manager`/`strategy` are the
library's `ContextManager`/`AutobiographicalStrategy`; `shim` is our
in-memory `JsStore` stand-in.

## File layout

All inside the existing package — same name, same plugin entry, every source
file rewritten:

```
packages/compaction/compaction-autobiographical/src/
  index.ts    — engine: plugin entry, runtime cache, fold pass, tick chain
  store.ts    — in-memory JsStore shim, wrapped in the drift Proxy
  seed.ts     — open-time seeding + live sync + surface-ground expansion
  plan.ts     — partition resolved messages by recollection → FoldOp list
  apply.ts    — preflight, then one bracket per op
  bridge.ts   — membrane complete() ↔ ctx.llm.stream
  config.ts   — schema + resolution
  types.ts    — config, mint and memory-progress record types, RecollectionRange
  invariant.ts — the registered no-op companion
```

The per-section line counts below are the shape each file has, stated in code
lines — the prose in these files is half their length, and counting `wc -l`
makes every one of them read as three times over budget.

Measured against the tree as it stands, code lines only: `apply` 93, `config`
16, `invariant` 8, `store` 134, `seed` 284, `plan` 258, `bridge` 186, `index`
434, `types` 49. That is **1462 code lines against the ~660 the plan
targeted**, with a further 1641 comment lines and 185 blank. The overage is
concentrated in `index` (434 vs ~230), `seed` (284 vs ~130) and `plan` (258 vs
~170), and it is carried by capability this sketch predates: replay-seeded mint
detection with a per-runtime cursor and attempt watermark, live
`autobio/memory-progress` streaming, the `Ranges` chain resolver that reaches
through a pyramid above L2, the calibration seq high-water, the `OverBudgetError`
retry arithmetic in `compileFolds`, tool-definition and system-prompt sync,
whole-pass widening against sibling claims, and the preflight that refuses a
plan before a bracket opens. It is not padding — the JSDoc is enforced by
`verify-export-jsdoc` and the coverage gate is `perFile: true` at 100% on all
four metrics. Trimming to 660 would mean dropping one of those behaviours, not
shortening these files.

## The one-paragraph architecture

The session log is the only durable store. On first touch of a session, we
create a `shim`, replay the log into it (surface events → `messages` slot;
`autobio/memory` events → `summaries` slot), and hand it to
`ContextManager.open({ store: shim, strategy, membrane: bridge })`. The
strategy's `initialize()` reads the seeded slots and "recovers" as if a
Chronicle archive had persisted. From then on the library plans and forms
memories exactly as upstream intends; the only writes back to DSH are fold
replace ops and log events. Process exit loses nothing because nothing the
shim holds is unrecomputable.

## Data shapes

### What the log gives us (all existing event types)

```
// surface events (surfaceOp: 'append'), mirrored 1:1 into the messages slot:
user/message      { content: ContentBlock[] }
assistant/message { message: { content, source, ... }, usage?: TokenUsage }
tool/result       { message: { content: [tool-result blocks] } }

// fold nodes (surfaceOp: { op: 'replace', start, end }): a single
//   assistant/message whose source carries compactionId "autobio:<summaryId>",
//   carrying sourceEventSeqs = the EXPANDED ground it took (coverage chain).
//   Its text leads with "[Recall <summaryId>]" only on the text fallback: a
//   recollection replayed from stored `responseContent` carries the captured
//   blocks verbatim, with no header to prepend.
// INVARIANT: every landed fold is tool-pair-safe (see plan.ts), so the live
// surface is always pair-safe and fold nodes never participate in straddles.

// mint record (log-only) — THE seed source for summaries:
autobio/memory {
  ...strategyStats,
  attempt: number,
  memory: { id, level, content, tokens, created,
            sourceRange: { firstSeq, lastSeq } },   // the surface span replaced
  usage?: TokenUsage,
}

// live progress (log-only) — one record per streamed flush, keyed to the call
// by `attempt`, and the terminal flush that closes it (success or failure):
autobio/memory-progress { attempt, delta, done?, error? }
```

### The store's internal model

```
class LogStore {
  registrations = Map<stateId, { id, strategy }>   // registerState; cadence fields ignored
  arrays        = Map<stateId, unknown[]>          // append_log slots
  scalars       = Map<stateId, unknown>            // snapshot slots
  branch        = { name: 'main' }                 // one stable object
  seq           = 0                                // next append position
}
// createStore() wraps an instance in the Proxy that answers everything else
// with the drift thrower, or with absence for the probed names.
```

Slot ids the strategy uses (all under ns `default/` unless configured):
`messages`, `context`, `autobio:summaries`, `autobio:chunks`,
`autobio:counter`, `autobio:mergeQueue`, `autobio:merge-quarantine`,
`autobio:pins`, `autobio:resolutions`, `autobio:locks`,
`autobio:calibration`, `autobio:compression-refusal-quarantine(-ledger)`,
`kvunified:presentation-receipt`. We never enumerate these; the strategy
registers what it needs at `initialize()` and the shim registers blindly.

## store.ts — the shim (~170 lines of code, ~280 lines with rationale)

Every method the library calls, verified by grep against
`ref/context-manager/src`. Anything else throws
`LogStore.<method>() called: the context-manager library moved a code path onto
it` — that throw is the upstream-drift alarm. Three names are answered with
absence instead, because the library `typeof`-probes them as capability checks:
`registerStateFieldIndex`, `queryStateIndexRange`, `queryStateIndexEq`, and the
`then`/`toJSON` a value meets outside the library.

```
registerState(reg):
  // idempotent; chronicle throws on re-register and the library CATCHES that
  // throw (ContextManager.open wraps registerState in try/catch for exactly
  // this), so matching chronicle's behavior matters:
  if regs.has(reg.id): throw Error(`State already exists: ${reg.id}`)
  regs.set(reg.id, reg)
  if reg.strategy == 'tree': throw Error('shim: tree states unsupported')
  // (tree is only registered by mint-preimage, config-gated off)

getStateJson(id):       return scalars.get(id) ?? arrays.get(id) ?? null
setStateJson(id, v):    scalars.set(id, v); return record('state_update')
getStateLen(id):        return arrays.get(id)?.length ?? null
getStateItemJson(id,i): return arrays.get(id)?.[i] ?? null
getStateSlice(id,off,limit):
  // chronicle returns a Buffer of the JSON-encoded slice; match that
  return Buffer.from(JSON.stringify(arrays.get(id)?.slice(off, off+limit) ?? []))

appendToStateJson(id, item):
  // NOT ('id', 'sequence'). A SummaryEntry is named 'L1-0' and the library
  // matches persisted summaries by item.id === entry.id
  // (autobiographical.ts:3649, warns and drops the merge state when it
  // misses). Splicing under 'id' overwrites that name with the shim's record
  // id and leaves setMergedInto unable to find its own entry — the
  // duplicate-id divergence four summaries were lost to.
  return appendToStateJsonWithIdentity(id, item, 'storeId', 'storeSequence')

appendToStateJsonWithIdentity(id, item, idField, seqField):
  // THE message-identity rule: ids are shim-assigned ordinals, so replaying
  // the same log reproduces the same ids on every open. summaries'
  // sourceRange references these ids; determinism is what makes seeding work.
  const rec = { id: String(++this.seq), sequence: this.seq }
  arrays.get(id).push({ ...item, [idField]: rec.id, [seqField]: rec.sequence })
  return rec

editStateItem(id, i, buf):   arrays.get(id)[i] = JSON.parse(buf.toString())
redactStateItems(id, s, e):
  // ONE-SENTENCE RULE: the messages slot is ordinal-addressed (message ids
  // ARE positions), so redacting it is a structural bug — throw. Every other
  // slot splices. Verified: the strategy redacts only its quarantine ledger
  // (autobiographical.ts:3297); removeMessage is host-driven API we never call.
  if (id === messagesSlotId) throw Error('shim: messages slot is append-only')
  arrays.get(id).splice(s, e - s)

currentBranch():    return this.branch          // one stable OBJECT, whose `name`
                                                 // the library compares everywhere it
                                                 // asks about the branch (message-store
                                                 // caches key on .name; getChannelTokenStats
                                                 // keys on .id); a fresh object per call
                                                 // would read as a branch switch and wipe
                                                 // the caches
currentSequence():  return this.seq - 1          // the HEAD of the log, not its
                                                 // length; -1 before the first write
updateStateStrategy(reg): regs.set(reg.id, reg)  // ContextManager.open feature-detects it
isClosed()/close(): trivial                        // nothing is held open
sync():             no-op   // NOTHING TO CHECKPOINT. the log is the fsync.
compactState(id):   no-op   // returns null
listStates():       [...regs entries]

// loud throws — unused in our config, and we want to know if that changes:
createBranchAt / switchBranch / deleteBranch / getStateJsonAt / getStateAt
treeSet / treeGet / treeBatch / treeList / treeDiff /
treeSnapshot / query / subscribe / unsubscribe / pollSubscription* /
catchUpSubscription / registerStateFieldIndex / queryStateIndex* /
getStateIndexValueCounts / appendWithLinks / appendJsonWithLinks /
getEffects / getLinksTo / stats / getCompactionSummary / compactAllStates /
setAutoSnapshot / autoSnapshotEnabled / getRecord / getRecordIdsByType /
getStateTail / recovery

// storeBlob/getBlob are not modelled and are NOT worth modelling.
// MessageStore.append does run content through BlobManager.extractBlobs, but
// that leaves an inline base64 image alone instead of writing a blob_ref and
// calling storeBlob, so the bytes the session log already holds are the bytes
// the library reads back. A blob map would be a second copy of data nothing
// consults. Deleting them changed no behaviour outside the unit test that
// asserted the map itself.
```

`getStore()` exposure on the manager returns the shim; nothing in our code
calls it.

## seed.ts — open-time seeding + live sync (~284 lines)

### Seeding (runs once per session open, before `ContextManager.open`)

```
function buildSeededShim(session, blockMap): ShimStore
  shim = new ShimStore()

  // pass 1 — messages. surface APPEND events only; replacements (our folds,
  // pruner nodes) are never mirrored — the strategy replans over originals.
  for event of session.events:
    if not isAppendSurfaceEvent(event): continue
    blocks = blockMap.toMembrane(event)          // ~40-line 1:1 vocab mapping
    if blocks.length == 0: continue
    shim.appendToStateJsonWithIdentity('messages', {
      participant: participantOf(event),         // 'user' | 'assistant'
      content: blocks,
      timestamp: event.time,                     // epoch millis, as Chronicle stores
      metadata: { dshSeq: event.seq },
    }, 'id', 'sequence')
    // record the seq mapping — messageId → dshSeq — for planning:
    seqByMessageId.set(lastId, event.seq)

  // pass 2 — summaries, from autobio/memory events (full content logged).
  summaries = []
  for event of session.events where type == 'autobio/memory' and data.memory:
    m = data.memory
    range = resolveRange(m)        // below
    if range == null: continue     // old unlanded mint w/o range: drop
    summaries.push({
      id: m.id, level: m.level, content: m.content, tokens: m.tokens,
      sourceLevel: m.level - 1,
      sourceIds:  level == 1 ? messageIdsInRange(range) : childIds(range),
      sourceRange: { first: leafFirst, last: leafLast },   // LEAF message ids, not
                                                          // the child recollections
      created: m.created,           // the mint's own clock, not the event's
    })
  linkPyramid(summaries)           // set mergedInto on every child: the entry the
                                   // log names as its parent is what the library
                                   // reads to tell its frontier from consolidated
                                   // ground; unset, a reopen re-merges children it
                                   // already merged — one call per reopen
  shim.arrays.set('default/autobio:summaries', summaries)
  shim.scalars.set('default/autobio:counter', 1 + maxNumericSuffix(loggedIds))
  // The counter advances over EVERY logged recollection id, dropped or not: a
  // seeding that drops an entry still owns its id, and a reissued id would put
  // two mints under one name.
  // chunks slot left EMPTY on purpose: the library's lazy migration rebuilds
  // chunk records from L1 sourceIds (autobiographical.ts ~1735). mergeQueue,
  // quarantines, resolutions, calibration: not seeded — self-healing state.
  return shim

resolveRange(m):
  if m.sourceRange present: return it                       // new events
  // legacy events: recover the range from the fold node that landed the mint.
  // The node is read the way foldIdOf reads it — the compactionId its message
  // source carries, or the "[Recall <id>]" header a pre-rewrite node leads with
  // — and the range is its cited seqs EXPANDED through the fold nodes they name,
  // because a node can cite an earlier fold's node rather than raw events.
  fold = foldNodes(session).get(m.id)
  return fold ? { firstSeq: fold.covered.firstSeq, lastSeq: fold.covered.lastSeq } : null
```

Above L1 the sources are the recollections' ids, resolved to the leaf messages
they bottom out in, so `sourceRange` always names messages; `recallCurveLeafIds`
rejects an entry whose range names anything else. A recollection whose ground is
not in the store is skipped rather than stubbed, and left out of `known` too.

### Live sync (every fold pass; the shim is rebuilt per open, so the cursor is
### process-local state, not a durability mechanism)

```
function syncNewEvents(runtime, session):
  for event of session.events where event.seq > runtime.cursor:
    runtime.cursor = event.seq
    if isAppendSurfaceEvent(event):
      id = runtime.manager.addMessage(participantOf(event), blocks, { dshSeq: event.seq })
      runtime.seqOf.set(id, event.seq)

function syncToolDefinitions(runtime, session):
  // Both halves are pushed on IDENTITY change: the header is one object per
  // request header the log holds, so `tools !== runtime.declaredTools` is the
  // whole change check, and the system prompt is pushed the same way.
  tools = session.requestHeader()?.tools
  if tools !== runtime.declaredTools: runtime.manager.setToolDefinitions(tools.map(schemaMapping))
  system = session.requestHeader()?.system
  if system !== runtime.declaredSystem: runtime.manager.setSystemPrompt(system)
  // A declaration set the session drops is not retracted: the library's own
  // setter ignores an empty list.
```

Note `addMessage` goes through the manager (not the shim directly) so the
strategy's `onNewMessage` fires — with `autoTickOnNewMessage: false` that
hook only does bookkeeping, never a tick — and so the write version the
message index revalidates against is bumped.

## index.ts — the plugin (~434 lines)

```
class AutobiographicalCompactionEngine extends CompactionEngine:
  inject = ['llm', 'tokenMeter']
  // tokenMeter is the fixed node estimator a fold's shadow price is measured
  // with; llm is the stream the compression calls ride.
  runtimes = Map<SessionId, Promise<Runtime>>   // open-once cache
  // Runtime = { manager, strategy, store, route, known, seqOf, walked,
  //             progress, cancellation, declaredTools, declaredSystem,
  //             recorded, calibrated, tickChain }

  constructor(ctx, config):
    this.config = resolveConfig(config)              // 3 knobs + strategy bag
    if this.config.auto: registerAutomaticFolding()  // the RESOLVED default, not `config.auto`
    ctx.on('agent/disposed', ({agent}) => this.runtimes.delete(agent.session.id))
    ctx.effect(() => () => this.runtimes.clear())
    // Dropping the map entry is the whole of disposal: the store is memory the
    // map was holding, not an artifact to close.

  // ── call point 1: automatic path ──────────────────────────────
  registerAutomaticFolding():
    ctx.on('agent/pre-step', async ({agent, turn, step, signal}, next) => {
      try { await this.foldPass(agent, { turn, step, signal }) }
      catch (e) { warn(`folding failed: ${e}; continuing the turn`) }
      return next()
    })

  // ── call point 2: /compact (manual) ───────────────────────────
  compactNow(agent, signal, _cmd):
    claimed = agent.runMaintenance(s =>
      this.foldPass(agent, { turn: null, step: 0, signal: AbortSignal.any([s, signal]) }))
    // A claim the agent refuses is the busy case (ManualCompactionError('busy')),
    // a thrown pass is classified by manualFailure (see below).

  // ── call point 3: explicit region — still rejected ────────────
  compactRegion(): return Promise.reject(ManualCompactionError('summary', …))

  // ── the pass ──────────────────────────────────────────────────
  async foldPass(agent, pass):
    routed = agent.session.requestContext()
    if routed?.contextWindow == null: return null   // unrouted: skip
    budget = this.computeBudget(routed.contextWindow)
    if budget == null: return null                  // reserve ≥ window: skip

    rt = await this.runtimeFor(agent, routed)       // open+seed on first touch
    syncSurface(rt, session)                        // walk the log since `walked`
    syncToolDefinitions(rt, session)                // tools + system prompt, on change
    feedCalibration(rt, session)                    // BEFORE compile (arm ordering)

    reached = await compileFolds(rt, budget, config.reserveTokens, warn)

    this.kickTick(rt, session, pass.signal)         // AFTER the compile attempt, refusal
                                                    // included; never awaited
    if (!reached) return null

    ops = planFolds(rt.store, session, { resolutions, summaries, seeded: rt.known,
                                         seqOf: rt.seqOf, price: priceSurfaceNode })
    if (ops.length == 0) return null
    return applyFolds(session, ops, pass.turn, pass.step, rt.route).at(-1)

  compileFolds(rt, budget, reserveTokens, warn):
    try { await rt.manager.compile(budget); return true }
    catch (e) {
      if not OverBudgetError: rethrow
      // The size the strategy could reach, converted back into a total budget:
      // `actual` is measured against the usable budget, total less the allowance.
      affordable = e.actual + reserveTokens
      try { await rt.manager.compile({ maxTokens: affordable,
                                       reserveForResponse: reserveTokens }); return true }
      catch (retry) {
        if not OverBudgetError: rethrow
        warn(`folding is ${retry.actual} tokens over budget ${retry.budget}; folding again next step`)
        return false
      }
    }

  computeBudget(window):
    // The reserve is subtracted here and again by the library as the response
    // allowance, so the live ceiling is the smaller of the route's window and
    // the configured one, less twice the reserve. No promptOverhead: the
    // calibration multiplier absorbs the envelope instead.
    maxTokens = min(window, config.operatingWindowTokens) - config.reserveTokens
    return maxTokens <= 0 ? null : { maxTokens, reserveForResponse: config.reserveTokens }

  feedCalibration(rt, session):
    // armed-once-per-compile inside the strategy; feeding when unarmed is a
    // no-op, so once per pass is exactly right. `calibrated` is the seq
    // high-water, so one usage sample is reported once and a step that
    // reported none leaves the mark where it is.
    sized = newest assistant/message with usage in session.events
    if sized == null or sized.seq <= rt.calibrated: return
    rt.calibrated = sized.seq
    rt.strategy.reportRealInputTokens(
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))

  kickTick(rt, session, signal):
    rt.cancellation.signal = signal      // read per call by the bridge, which starts
                                         // after the pass that armed it returned
    settle = () => { if this.runtimes.has(session.id) this.appendMemory(rt, session) }
    rt.tickChain = rt.tickChain
      .then(() => rt.manager.tick())     // → bridge.complete() → ctx.llm
      .then(() => settle(), error => { settle(); warn(`memory formation failed: ${error}`) })
    // ONE tick in flight per session. `settle` writes the record on the failure
    // path too, and before the failure is reported: the attempt counter advances
    // inside the compression call, so a tick that failed after that advance holds
    // a count the log can only learn from its record.

  appendMemory(rt, session):
    // The record is written when the tick minted a recollection OR the attempt
    // counter moved; otherwise it would append an identical event every pass.
    // `progress.usage` sums every call the tick settled, not the last one.
    // A record the log refuses is reported whole (the log's error, an isJsonValue
    // verdict, the bounded JSON) and NOT written: `recorded` and `known` move
    // only once the record is durable, so a refused record is retried next pass
    // instead of leaving a recollection announced forever and absent from the
    // archive.
```

`runtimeFor(agent, route)` = open-once cache; a failed open is dropped (but not
one opened since, which the identity comparison tells apart). On open:

```
async openRuntime(session, route):
  store = createStore()
  seed  = seedFromLog(store, session)   // registers the slots, replays, links
  strat = new AutobiographicalStrategy({
    ...config.strategy,                  // the passthrough bag — upstream knobs
    compressionModel: route.model,       // voice = the session's own model
    summaryParticipant: 'assistant',
    adaptiveResolution: true,
    autoTickOnNewMessage: false,         // replay would storm ticks otherwise
    foldingStrategy: 'kv-stable',        // harness default; bag can override
    carrierPolicy: 'live-strip',         // price folds at stripped render
  })
  manager = await ContextManager.open({
    store: store as never,               // ← THE WHOLE POINT. Duck-typed by the
                                         // library; its published type is the
                                         // Chronicle native class, so one cast
                                         // states the mismatch.
    strategy: strat,
    membrane: createBridge({ llm, provider, warn, signal: () => cancellation.signal, onText }),
    // NO tokenEstimator. Giving the manager one REPLACES its default rather
    // than layering on it, and the default is better than a flat /4: it
    // samples the first 2000 chars and picks 2.9 or 2.3 chars/token by density
    // (message-store.ts:1723-1744). Calibration does not correct a crude
    // estimator as this doc once claimed — it is a single global MULTIPLIER
    // (tokenCalibration, default 1, clamped to 0.25..4 by setTokenCalibration),
    // which scales one estimate uniformly and cannot tell prose from code. A
    // flat /4 would misprice every pick and stay mispriced.
  })
  recorded = attemptFromLog(session)     // the count a reopen resumes from
  return { manager, strategy: manager.getStrategy(), store, route,
           known: seed.known, seqOf: seed.seqOf,
           walked: session.events.length - 1, progress, cancellation,
           declaredTools: undefined, declaredSystem: undefined,
           recorded, calibrated: 0, tickChain: Promise.resolve() }
```

## plan.ts — partition by recollection, then widen (~258 lines)

Replaces `applicator.ts` wholesale. No entry parsing, no `previewContext`,
no repair chains. Two hardening rules, deliberate:

- **Divergence throws, never skips.** Seeding is deterministic, so a
  plan/surface mismatch is always a bug. The walk throws with the offending
  ids; the engine boundary catches, warns, and continues the turn. The old
  code's `return null` paths made bugs indistinguishable from "nothing to
  fold" — that failure-invisibility is how the bug tail grew.
- **The surface is always pair-safe** (invariant, maintained inductively by
  the widening pass below). Fold nodes therefore never participate in a
  straddle, so boundary handling never needs to look past immediate raw
  neighbors.

This is one phase longer than the "frontier walk" this section first
specified, because run-grouping cannot work: a resolution lands on the
*messages* a recollection covered, so two adjacent recollections at the same
level resolve their messages to the same level and a run of equal levels spans
ground no single recollection owns. Partitioning by the entry that stands over
each resolved message is what makes the fold's span well defined.

```
function planFolds(store, session, {resolutions, summaries, seeded, seqOf, price})
  ranges   = standing()          // per level, live recollections and their
                                 // coverage (seeded ∪ resolved, both unioned),
                                 // in mint order. A merged child is NOT skipped:
                                 // `mergedInto` records formation, not
                                 // representation — until the parent's fold
                                 // lands, the child's node is what the surface
                                 // shows for that ground.
  place    = {}                  // log seq → the surface position holding it
  surface  = annotateSurface(session, price, place)
             // per node { seq, coverage (sourceEventSeqs expansion through
             // fold nodes, memoized in seed.ts as surfaceGround), foldId
             // (compactionId, autobio: prefix), calls, results, tokens }
             // The FIRST node holding a seq owns its position in `place`.

  // pass 1 — partition the resolved messages by the recollection standing over
  // them, which is the fold each one belongs to.
  claims = {}
  for msg of messages slot, in order:
    level = resolutions.get(msg.id) ?? 0
    if level == 0 or msg has no sane dshSeq: continue
    summary = standingFor(ranges, level, msg.dshSeq) ?? throw Divergence
    claims[summary.id].keys ∪= seq
    if place[seq] != null: claims[summary.id].claimed ∪= place[seq]

  ordered = claims with a non-empty claim, in first-claimed-position order
  taken   = {}                   // surface positions an op has landed on
  ops     = []
  for op of ordered:
    run   = every position from op's first claim to its last
    span  = run up to the first position in `taken`   // sibling ground is a wall
    if span is settled (every position holds this recollection's own node): continue
    widen(op, taken)             // below
    recompute span; drop the positions a sibling took
    ops.push({ summaryId, level, startSeq, endSeq, shadowedSeqs, shadowedTokens,
               summary, coveredNodes })
               // coveredNodes = the span's nodes plus, under each landed fold
               // node this op's claim covers, the nodes that node stands for
    taken ∪= span                // what a fold replaces is ground spoken for

  // pass 2 — pair-safe widening, against FINAL visibility (a node is visible
  // after this pass iff no op shadows it). Both directions are provably
  // chain-free because calls and results never share a node in the DSH event
  // model (calls: assistant/messages; results: tool/result events —
  // agent-loop/src/tool-calls.ts:281).
  widen(op, taken):
    back:   while the span's left edge is not a node declaring calls: walk one
            node back and stop in front of anything in `taken`, in front of a
            node declaring calls the span does not answer, and in front of a
            node bringing no result the span is missing; the node that declares
            the calls is the round's head and the last node the walk takes.
    fwd:    while the span declares calls whose results are still unanswered:
            take the next node when it answers the span and declares no calls,
            else stop.
    // The walk stops at sibling ground rather than crossing it, which is what
    // leaves the sibling its own round.
```

A later op's walk reads the positions earlier ops landed on, so the spans are
disjoint by construction: the shared set is built before any walk runs and each
walk stops in front of ground a sibling already owns. An op whose whole claim a
sibling took is left out rather than landed over it, and an op that already
holds its own node across the span is settled — folding again would trade the
two places forever.

Deliberately absent vs. the old applicator: `parseDesired`, recall-pair
reconstruction, chaining loops, the absorbed-node set, refusal paths, and
every silent skip. Divergence is a `DivergenceError` thrown out of the pass,
which the engine boundary catches, warns about, and retries next step.

## apply.ts — preflight, then one bracket per op (~93 lines)

Pure mechanics: planning (including widening) already happened, so this file
cannot make a pairing mistake — it just lands ops.

```
function applyFolds(session, ops, turn, step, route): CompactionResult[]
  assertFoldOpsApply(session, ops)   // preflight BEFORE the first bracket opens:
                                     // every covered node is on the LIVE surface,
                                     // the span's edges are the nodes it cites,
                                     // foldBlocks(op.summary) is JSON-storable, and
                                     // no two ops claim one position. A refusal has
                                     // to happen here or not at all — a
                                     // compaction/start left open strands the lock
                                     // and the invariant then refuses the next
                                     // start and every turn boundary.
  return ops.map(op => land(session, op, turn, step, route))

function land(session, op, turn, step, route): CompactionResult
  // One bracket per op, and the bracket id IS the fold's identity:
  compactionId = CompactionId(`autobio:${op.summaryId}`)
  startSeq = session.append('compaction/start', { compactionId, turn }).seq
  summarySeq = session.append('compaction/summary', { compactionId,
    summary: foldBlocks(op.summary),
    shadowedRange: { start: op.startSeq, end: op.endSeq },
    shadowedSeqs: op.shadowedSeqs, shadowedTokenCount: op.shadowedTokens,
    provider: route.provider, model: route.model }).seq
  // One node for the whole range, appended synchronously after its metering
  // event as the shadow-price protocol requires. `step` names where the
  // recollection belongs — the step the pass is preparing — not a step the
  // session already holds, and the replacement records 0 when there is no turn.
  session.append('assistant/message', {
    turn: turn ?? 0, step,
    message: createAssistantMessage({ content: foldBlocks(op.summary),
      source: { provider: route.provider, model: route.model, compactionId } }) },
    { surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq },
      sourceEventSeqs: op.coveredNodes })    // the EXPANDED ground, not the
                                             // span's node list
  endSeq = session.append('compaction/end', { compactionId, turn }).seq
  return { compactionId, startSeq, summarySeq, endSeq, summary, … }
```

`applyFold` is the single-op form: it calls `applyFolds` with one op, so the
preflight is the same one. Provenance comes from the route the runtime was
opened with; re-resolving it at apply time would fabricate an empty options bag
and write `''` into the fold message's model source, which seed validation
rejects on replay.

Wire validity rests on the invariant, not on this file: because every landed
fold is pair-safe, the derived wire always has every `tool_calls` answered by
its `role:tool` entries. Recognising a fold node on a later pass is
`foldIdOf`'s job: the `autobio:` compaction id on the message source first —
which carries no text header at all when the recollection replays stored
`responseContent` — and the `[Recall <id>]` header it leads with only on the
text fallback.

## bridge.ts — membrane ↔ ctx.llm (~186 lines)

```
function createBridge({ llm, provider, maxTokens?, agentParticipant?, warn?, signal?, onText? }): Membrane
  // Only `complete` is implemented; the rest of the class is streaming, retry
  // and provider plumbing the harness already owns.

  async complete(request: NormalizedRequest):
    // 1. map messages (1:1 vocab: text↔text, thinking↔reasoning,
    //    tool_use↔tool-call, tool_result↔tool-result; redacted_thinking maps
    //    away, an unknown type becomes a loud `[<type> omitted …]` placeholder)
    // 2. participant mapping: agentParticipant → 'assistant'; a foreign
    //    participant keeps its name as a text prefix on the block it opens with
    // 3. tool results are hoisted into tool-result messages of their own,
    //    ahead of the prose that trailed them, because the wire serializer
    //    emits a mixed message's text before its tool entries and would orphan
    //    them from the call they answer. NO split happens here: the library ran
    //    splitMixedToolMessages and collapseConsecutiveMessages before building
    //    this request (autobiographical.ts:5517), so a result already arrives
    //    alone or heads its message.
    // 4. stream:
    signal = options.signal?.()        // read at the call: the tick that makes
                                       // it runs after the pass that armed it
    for await (chunk of llm.stream({
      provider, model: request.config.model,   // the library's resolved voice
      messages,
      system: request.system,
      tools: request.tools?.map(toHarnessTool),   // ← FORWARDED. the refusal
                                                   //   ladder needs them on the wire
      maxTokens: request.config.maxTokens > 0
        ? max(request.config.maxTokens, maxTokens ?? 0) : maxTokens,  // a FLOOR
      temperature: request.config.temperature,
      signal, purpose: 'compaction',
    })):
      if chunk.type == 'text-delta': onText?.(chunk.text, false)
      assembler.push(chunk)
    // A thrown call and an error/aborted finish both end the attempt with the
    // failure; the terminal flush closes it either way, which is what gives a
    // call that streamed nothing a row of its own:
    onText?.('', true, assembler.usage, failure)

    // 5. thinking-strip pricing: if thinking+text characters exceed the source
    //    characters, return the response WITHOUT thinking blocks (a fold must
    //    never cost more than the span it replaces). A character test, not a
    //    token account.
    // 6. return membrane response with { content, rawAssistantText, stopReason,
    //    usage: { inputTokens, outputTokens }, toolCalls: [], toolResults: [] }
```

## config.ts (~41 lines)

```
Config = Schema.object({
  operatingWindowTokens: Schema.number().step(1).min(1).optional(),  // default:
                                     // the cap below, not the route's window
  reserveTokens:  Schema.number().step(1).min(0).default(8192),
  auto:           Schema.boolean().default(true),
  strategy:       Schema.dict(Schema.any()).default({}),  // PASSTHROUGH — handed
                  // to AutobiographicalStrategy untouched; upstream knobs flow
                  // with the version bump (kvStableReachTokens,
                  // speculativeProduction, summaryTargetTokens, …)
})

resolveConfig(config):
  operatingWindowTokens: config.operatingWindowTokens ?? OPERATING_WINDOW_CAP (65_536)
  reserveTokens:         config.reserveTokens ?? 8192
  auto:                  config.auto ?? true
  strategy:              config.strategy ?? {}
  // The schema defaults and the resolver agree; the RESOLVED value is what the
  // constructor's `auto` check reads.
```

The strategy keeps the harness's own requirements over the bag: the integration
sets `compressionModel`, `summaryParticipant`, `adaptiveResolution`,
`autoTickOnNewMessage: false`, `foldingStrategy: 'kv-stable'` and
`carrierPolicy: 'live-strip'` after spreading `config.strategy`, so a bag entry
on one of those names does not win.

Gone vs. today: `storeRoot` (no store), `recentWindowTokens` /
`headWindowTokens` / `maxMessageTokens` / `targetChunkTokens` /
`mergeThreshold` / `maxTokens` / `foldingStrategy` /
`contextWindowTokensByModel` (all live in the `strategy` bag now).
Trade-off: the config catalog's static walk sees only the three harness
knobs; the bag gets a prose note in the README.

## Call-point inventory (who calls what)

| Trigger | Path |
|---|---|
| plugin load | `constructor` → register `agent/pre-step` (if the resolved `auto`), `agent/disposed`, dispose effect |
| every agent step | `agent/pre-step` → `foldPass` → `syncSurface` → `syncToolDefinitions` → `feedCalibration` → `compileFolds` → `kickTick` (bg, refusal included) → `planFolds` → `applyFolds` |
| `/compact` | `compactNow` → `agent.runMaintenance` → `foldPass` (turn `null`, maintenance and request signals composed) |
| memory formation | `manager.tick()` (library) → `bridge.complete()` → `ctx.llm.stream` → `appendMemory` writes the `autobio/memory` record for the tick (mint and/or settled attempt) |
| session fork | *nothing* — the forked log carries the events; the child's first fold pass seeds from them |
| process restart / kill -9 | *nothing* — next open re-seeds from the log; zero LLM calls |
| `agent/disposed` / shutdown | drop the map entry — the store it held is the only thing to release |

## Sequence walkthroughs

**Cold open of a long session.** First `agent/pre-step` → `runtimeFor` →
`seedFromLog` replays N events (~4k surface messages + ~200 summary events for
the red-lemma session) → `ContextManager.open` → strategy `initialize()` reads
the seeded slots, rebuilds chunk records from L1 `sourceIds` via its
lazy-migration path, and reads the `mergedInto` links sealing the pyramid → the
fold pass proceeds with a complete pyramid. No LLM calls.

**Steady-state step.** `syncSurface` appends the step's new events →
`compile(budget)` commits the frontier → `kickTick` hands the background chain
one tick → walk usually produces zero ops (surface already matches) → `next()`.

**Over budget mid-formation.** `compile` throws `OverBudgetError` with `actual`
measured on the library's usable budget → retry compile at `actual + reserve`
→ land that layout. If even that refuses: warn with both figures, land nothing,
and try again next step. The turn NEVER waits on ticks, and the tick kicked
after the refusal is what raises the floor the retry finds.

**kill -9 at an arbitrary point.** Nothing to do. The store dies; the log is
untouched; next open is the cold-open path.

**Fork.** Nothing to do. The child's log already contains every
`autobio/memory` event up to the fork point; seeding inherits the pyramid.

## Test plan

1. **Shim conformance**: scripted event log → seed → open → assert
   `summaries`/`messages`/counter contents; open twice, assert byte-identical
   seeds (determinism = the id-injection rule).
2. **Red-lemma replay**: a real 1.27M-event log → seed → `compile` → walk;
   assert the planned folds are consistent with the fold nodes the session
   actually landed (Recall ids match, ranges match). Deferred: the fixture is
   scripted to red-lemma *shapes*, not replayed from the real log.
3. **No-regeneration proof**: drive one engine over a session until it settles,
   then reopen a second engine that shares nothing but the log; assert zero
   bridge calls and a working plan.
4. **Pair-safety invariant tests**: scripted surfaces with call/result
   straddles at both boundaries (including sibling-op adjacency); assert the
   widened ranges leave a pair-safe surface, and serialize the result through
   the real `serializeMessages` to prove wire validity. The property test over
   real session logs is deferred with the replay fixture.
5. **Bridge**: tools forwarded; no split at this layer (the library splits
   upstream) and a hoisted tool result heads its own message; thinking strip
   triggers when thinking+text exceeds the source.
6. **Calibration**: feed synthetic usage; assert one sample consumed per
   compile and out-of-band rejection leaves the multiplier alone.

## Pre-build verification list (from the plan doc, restated)

1. `strategy.resolutions` shape after `compile()` on a replayed session —
   per-message id → level, runs align with summary `sourceRange`s.
2. `reportRealInputTokens` contract — which token total, arm timing vs.
   `compile()`.
3. `getStateSlice` Buffer encoding (JSON array?) — one read of chronicle's
   message-store usage path settles it.
4. Chronicle is a *value* import in the library (`import { JsStore }`), so
   the native module still loads transitively even though we never open a
   store. Acceptable (unused); worth an upstream note.
5. Session-ownership: confirm two processes can't hold the same live session
   (the archive's LOCK used to answer this for the store).

## Known limitations and deferred work

- **A folded message can keep a stale resolution (P11)** — the library's
  `selectAdaptive` stages resolution changes only for messages outside the
  head and tail windows (`autobiographical.ts:7878`:
  `if (headMessageIds.has(id) || tailMessageIds.has(id)) continue`), and
  `resolutions` has no delete path anywhere — a map entry is only ever
  overwritten by a later compile or cleared with the whole map. A message
  folded into a recollection while it sat in a head/tail window therefore
  keeps its non-zero resolution when it later leaves that window, and the
  planner reads it as covered ground: it can fold verbatim ground under a
  recollection that does not stand over it. Recorded, not fixed — a correct
  fix needs library-side state this backend cannot read (a resolution's
  removal, or a per-compile frontier that names only standing entries). The
  failure direction is premature folding, not an unfolded session.
- **The session invariant refuses a fold node outside an open step** — with
  `dsh-invariants` and `packages/core/session/src/invariant.ts` mounted,
  `requireOpenStep` rejects an `assistant/message` naming turn *t*/step *s*
  when the open step is `null`, which is exactly the fold a turn-boundary pass
  lands: `assistant/message names turn 1/step 1 but open is turn 1/step null`.
  The token meter carries the matching exemption (a message whose source holds
  a `compactionId` takes no step anchor), the session invariant does not. A
  deployment that mounts both needs the same exemption there.
- **A call that streams nothing and reports no failure leaves no row** — the
  bridge's terminal flush closes an attempt that produced text or an error;
  a call that succeeds with an empty body is invisible to the chat. Pinned
  pre-existing behavior, not a regression.
- **The red-lemma replay fixture and its property test are not built** — both
  promised above. The acceptance tests use fixtures scripted to red-lemma
  *shapes* (threshold-plus-remainder pyramids, parallel tool rounds, legacy
  fold nodes); a real 1.27M-event log replay is a separate acceptance harness.
- **Upstream asks**: a public `resolutions` accessor (this backend reads the
  protected field, as connectome-host's own UI does); a documented `JsStore`
  injection surface; a Chronicle value-import that does not pull the native
  module transitively; and the P11 resolution-removal path.
