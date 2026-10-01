# Log-native Connectome: implementation detail

Companion to `CONNECTOME-LOG-NATIVE-PLAN.md` (the *why*). This doc is the
*what*: module layout, every call point, and pseudocode for each piece. No
code here is final; it exists to make the build mechanical and to expose
design gaps before they cost a rewrite.

Conventions below: `session` is a DSH `Session`; `manager`/`strategy` are the
library's `ContextManager`/`AutobiographicalStrategy`; `shim` is our
in-memory `JsStore` stand-in. Pseudocode is TypeScript-shaped but elides
types where they don't carry meaning.

## File layout

All inside the existing package — same name, same plugin entry, every source
file rewritten:

```
packages/compaction/compaction-autobiographical/src/
  index.ts    — engine: plugin entry, runtime cache, fold pass, tick chain
  store.ts    — in-memory JsStore shim
  seed.ts     — open-time seeding + live sync from the session log
  plan.ts     — partition resolved messages by recollection → FoldOp list
  apply.ts    — fold execution: preflight + bracket/memory events + replaces
  bridge.ts   — membrane complete() ↔ ctx.llm.stream
  config.ts   — schema + resolution
  types.ts    — FoldOp, RuntimeEntry, config types
```

Deleted in the same change: `mirror.ts`, `membrane.ts`, `applicator.ts`,
`invariant.ts` (folded into `index.ts` or kept one-liner per package
convention), `command-autobio` package, the autobio UI conversation nodes,
and every `inheritForkArchive`/watermark/checkpoint code path.

The per-section line counts below are the shape each file should have, stated
in code lines — the prose in these files is half their length, and counting
`wc -l` makes every one of them read as three times over budget. Measured
against the tree as it stands: `apply` 47, `config` 17, `store` 121,
`seed` 162, `bridge` 172, `plan` 170, `index` 329.

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

// fold nodes (surfaceOp: { op: 'replace', start, end }): always a single
//   assistant/message with text "[Recall <summaryId>]\n\n<content>",
//   carrying sourceEventSeqs = shadowed seqs (coverage chain).
// INVARIANT: every landed fold is tool-pair-safe (see plan.ts), so the live
// surface is always pair-safe and fold nodes never participate in straddles.

// mint record (log-only) — THE seed source for summaries:
autobio/memory {
  ...strategyStats,
  attempt: number,
  memory: { id, level, content, tokens,
            sourceRange: { firstSeq, lastSeq } }   // ← NEW FIELD, this change
}
```

### The shim's internal model

```
class ShimStore {
  regs    = Map<stateId, { strategy: 'append_log' | 'snapshot' }>
  arrays  = Map<stateId, unknown[]>          // append_log slots
  scalars = Map<stateId, unknown>            // snapshot slots
  seq     = 0                                // global record sequence
  closed  = false
}
```

Slot ids the strategy uses (all under ns `default/` unless configured):
`messages`, `context`, `autobio:summaries`, `autobio:chunks`,
`autobio:counter`, `autobio:mergeQueue`, `autobio:merge-quarantine`,
`autobio:pins`, `autobio:resolutions`, `autobio:locks`,
`autobio:calibration`, `autobio:compression-refusal-quarantine(-ledger)`,
`kvunified:presentation-receipt`. We never enumerate these; the strategy
registers what it needs at `initialize()` and the shim registers blindly.

## store.ts — the shim (~120 lines of code, ~270 with rationale)

Every method the library calls, verified by grep against
`ref/context-manager/src`. Anything else throws `Error('shim: <method> not
implemented')` — that throw is the upstream-drift alarm.

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

currentBranch():    return this.branch          // one stable OBJECT: callers
                                                 // compare it by identity, and a
                                                 // fresh object per call reads as a
                                                 // branch switch and wipes the token cache
currentSequence():  return this.seq - 1          // the HEAD of the log, not its
                                                 // length; -1 before the first write
isClosed()/close(): trivial                        // never fire (WeakMap gen 0)
sync():             no-op   // NOTHING TO CHECKPOINT. the log is the fsync.
compactState(id):   no-op
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

## seed.ts — open-time seeding + live sync (~130 lines)

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
      timestamp: event.time,
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
      sourceRange: { first: msgId(range.firstSeq), last: msgId(range.lastSeq) },
      created: event.time,
    })
  rebuildPyramidLinks(summaries)   // set parentId: each L_k's children are
                                   // the L_{k-1}s whose ranges partition its
                                   // range; bottom-up, one pass
  shim.arrays.set('default/autobio:summaries', summaries)
  shim.scalars.set('default/autobio:counter', maxNumericSuffix(summaries) + 1)
  // chunks slot left EMPTY on purpose: the library's lazy migration rebuilds
  // chunk records from L1 sourceIds (autobiographical.ts ~1735). mergeQueue,
  // quarantines, resolutions, calibration: not seeded — self-healing state.
  return shim

resolveRange(m):
  if m.sourceRange present: return it                       // new events
  // legacy events: only landed folds are recoverable — the fold node carries
  // "[Recall <id>]" and sourceEventSeqs:
  fold = session.events.find(e => isReplacement(e) && recallHeader(e) == m.id)
  return fold ? { firstSeq: min(fold.sourceEventSeqs), lastSeq: max(...) } : null
```

### Live sync (every fold pass; the shim is rebuilt per open, so the cursor is
### process-local state, not a durability mechanism)

```
function syncNewEvents(runtime, session):
  for event of session.events where event.seq > runtime.cursor:
    if isAppendSurfaceEvent(event):
      blocks = blockMap.toMembrane(event)
      if blocks.length: runtime.manager.addMessage(participantOf(event), blocks, { dshSeq: event.seq })
    runtime.cursor = event.seq

function syncToolDefinitions(runtime, session):
  tools = session.requestHeader()?.tools
  if tools changed since last push:
    runtime.manager.setToolDefinitions(tools.map(schemaMapping))  // same as today
```

Note `addMessage` goes through the manager (not the shim directly) so the
strategy's `onNewMessage` fires — with `autoTickOnNewMessage: false` that
hook only does bookkeeping, never a tick.

## engine.ts — the plugin (~230 lines)

```
class AutobiographicalCompactionEngine extends CompactionEngine:
  inject = ['llm', 'compaction']
  runtimes = Map<SessionId, Promise<RuntimeEntry>>   // open-once cache
  // RuntimeEntry = { manager, strategy, shim, cursor, tickChain, route }

  constructor(ctx, config):
    this.config = resolveConfig(config)              // 3 knobs + strategy bag
    if config.auto: registerAutomaticFolding()
    ctx.on('agent/disposed', ({agent}) => dropAndClose(agent.session.id))
    ctx.effect(function* { yield () => this.closeAll() })
    // closeAll is hygiene only (manager.close() releases library resources).
    // NO durability role — there is nothing to checkpoint.

  // ── call point 1: automatic path ──────────────────────────────
  registerAutomaticFolding():
    ctx.on('agent/pre-step', async ({agent, turn, step, signal}, next) => {
      if (!signal.aborted):
        try { await this.foldPass(agent, signal, turn, step) }
        catch (e) { warn(`folding failed: ${e}; continuing the turn`) }
      return next()
    })

  // ── call point 2: /compact (manual) ───────────────────────────
  compactNow(agent, signal, _cmd):
    return agent.runMaintenance(s =>
      this.foldPass(agent, AbortSignal.any([signal, s]), null, 0))

  // ── call point 3: explicit region — still rejected ────────────
  compactRegion(): return Promise.reject(ManualCompactionError('summary', …))

  // ── the pass ──────────────────────────────────────────────────
  async foldPass(agent, signal, turn, step):
    session = agent.session
    rt = await this.runtimeFor(agent)     // open+seed on first touch
    syncNewEvents(rt, session)
    syncToolDefinitions(rt, session)
    this.kickTick(rt, session)            // background; NEVER awaited here

    this.feedCalibration(rt, session)     // BEFORE compile (arm ordering)

    budget = this.computeBudget(session)  // below
    if budget == null: return null        // unrouted session: skip

    // over-budget-at-floor handling, without previewContext:
    try {
      await rt.manager.compile(budget)
    } catch (e) {
      if e is OverBudgetError and typeof e.actual == 'number':
        // pyramid mid-formation: land the floor layout instead of stranding
        await rt.manager.compile({ maxTokens: e.actual + budget.reserveForResponse,
                                   reserveForResponse: budget.reserveForResponse })
      else { warn(...); return null }     // genuinely no layout: proceed raw
    }
    signal.throwIfAborted()

    ops = planFolds(session, rt)          // plan.ts
    if ops == null: { warn('plan diverged; skipping pass'); return null }
    if ops.length == 0: return null
    return applyFolds(session, ops, turn, step, rt)   // apply.ts

  computeBudget(session):
    routed = session.requestContext()
    if routed?.contextWindow == null: return null
    window = config.operatingWindowTokens ?? min(routed.contextWindow, 65_536)
    return { maxTokens: window - config.reserveTokens,
             reserveForResponse: config.reserveTokens }
    // NOTE: no promptOverhead subtraction. system-prompt/tool/reasoning
    // overhead is absorbed by the library's calibration multiplier instead.

  feedCalibration(rt, session):
    // armed-once-per-compile inside the strategy; feeding when unarmed is a
    // no-op, so once per pass is exactly right. Feed the newest usage that
    // POSTDATES the previous compile — i.e. the request built from it.
    usage = newest assistant/message usage in session.events after rt.lastFedSeq
    if usage:
      rt.strategy.reportRealInputTokens(
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
      rt.lastFedSeq = thatEvent.seq

  kickTick(rt, session):
    rt.tickChain = rt.tickChain.then(async () => {
      known = new Set(rt.manager.getSummariesInRange({}).map(s => s.id))
      await rt.manager.tick()             // → bridge.complete() → ctx.llm
      // mint detection is an id set-diff ONLY — no stats comparison:
      minted = rt.manager.getSummariesInRange({}).filter(s => !known.has(s.id))
      for m of minted:
        session.append('autobio/memory', {
          ...rt.strategy.getStats(),
          attempt: <attempt counter>,
          memory: { id: m.id, level: m.level, content: m.content,
                    tokens: m.tokens,
                    sourceRange: { firstSeq: seqOf(m.sourceRange.first),
                                   lastSeq:  seqOf(m.sourceRange.last) } },
        })
    }).catch(e => warn(`memory formation failed: ${e}`))
    // one tick in flight per session; errors quarantine library-side
```

`runtimeFor(agent)` = open-once cache; on open:

```
async openRuntime(session, route):
  shim  = buildSeededShim(session, blockMap)
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
    store: shim,                         // ← THE WHOLE POINT
    strategy: strat,
    membrane: bridge,
    // NO tokenEstimator. Giving the manager one REPLACES its default rather
    // than layering on it, and the default is better than a flat /4: it
    // samples the first 2000 chars and picks 2.9 or 2.3 chars/token by density
    // (message-store.ts:1723-1744). Calibration does not correct a crude
    // estimator as this doc once claimed — it is a single global MULTIPLIER
    // (tokenCalibration, default 1, clamped to 0.25..4 by setTokenCalibration),
    // which scales one estimate uniformly and cannot tell prose from code. A
    // flat /4 would misprice every pick and stay mispriced.
  })
  return { manager, strategy: strat, shim, cursor: session.events.at(-1)?.seq ?? -1, … }
```

## plan.ts — partition by recollection, then widen (~170 lines)

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
function planFolds(store, session, {resolutions, summaries, seeded, seqOf})
  ranges   = standing()          // per level, live recollections and their
                                 // coverage (seeded ∪ resolved, both unioned),
                                 // in mint order
  surface  = annotateSurface(session)
             // per node { seq, coverage (sourceEventSeqs expansion through
             // fold nodes, memoized in seed.ts as surfaceGround), foldId
             // (compactionId, autobio: prefix), calls, results, tokens }

  // pass 1 — partition the resolved messages by the recollection standing over
  // them, which is the fold each one belongs to.
  claimed = {}
  for msg of messages slot, in order:
    level = resolutions.get(msg.id) ?? 0
    if level == 0 or msg has no sane dshSeq: continue
    summary = standingFor(ranges, level, msg.dshSeq) ?? throw Divergence
    claimed[summary.id] ∪= { first: min, last: max }     // coverage only widens

  for { summary, first, last } of claimed:
    covers(node) = node.foldId != summary.id
                   and node.coverage overlaps [first, last]
    from = first node that covers ?? continue    // already carried, or nothing
    to   = last node in the contiguous run that covers
    ops.push({ summaryId, level, startSeq, endSeq, shadowedSeqs,
               shadowedTokens, summary, span: { from, to } })

  // pass 2 — pair-safe widening, against FINAL visibility (a node is visible
  // after this pass iff no op shadows it). Both directions are provably
  // chain-free because calls and results never share a node in the DSH event
  // model (calls: assistant/messages; results: tool/result events —
  // agent-loop/src/tool-calls.ts:281).
  for op of ops (in order):
    back:   if the node before op.span.from declares calls answered inside
            op's span → extend from over it.
            It is one assistant node; it carries no results; done.
            (A fold node there can't straddle — the invariant.)
    fwd:    if op's span declares calls whose results STAY VISIBLE after
            op.span.to → extend to over that contiguous result run, which
            stops at the first node that asks as well as answers.
    recompute startSeq, endSeq, shadowedSeqs, shadowedTokens when widened
```

Widening needs no record of what earlier ops claimed. One node answers to one
recollection — `covers` excludes a node carrying a different fold id, and
`syncSurface` never mirrors a fold node, so its seq cannot appear in
`resolutions` — so the spans the partition produced are already disjoint, and
nodes sit between a fold's first and last node only when that fold owns them.
The sibling boundary falls out of the partition rather than being tracked, so
there is no retract: an op's span cannot reach into a sibling's ground, because
the run stops at the first node that sibling claimed.

Deliberately absent vs. the old applicator: `parseDesired`, recall-pair
reconstruction, chaining loops, the absorbed-node set, refusal paths, and
every silent skip. The one interaction rule (widen against final visibility)
is the whole sibling-op story.

## apply.ts — fold execution (~60 lines)

Pure mechanics: planning (including widening) already happened, so this file
cannot make a pairing mistake — it just lands ops.

```
function applyFolds(session, ops, turn, step, rt): CompactionResult
  assertFoldOpsApply(session.surface.nodes, ops)   // kept from the old code:
                                                   // preflight BEFORE the
                                                   // bracket opens — a bad
                                                   // plan never strands an
                                                   // open compaction
  compactionId = CompactionId(`autobio-${session.id}-${++counter}`)
  startSeq = session.append('compaction/start', { compactionId, turn }).seq

  for op of ops:
    session.append('compaction/summary', { compactionId, summary: op.blocks,
      shadowedRange: { startSeq: op.startSeq, endSeq: op.endSeq },
      shadowedSeqs: op.shadowedSeqs, shadowedTokenCount: op.shadowedTokens,
      provider, model })
    // always a single assistant/message replace node, exactly as today —
    // planning already widened to pair-safe boundaries, so nothing here
    // touches pairing at all:
    session.append('assistant/message', { turn: turn ?? 0, step,
      message: createMessage({ role: 'assistant',
        content: [{ type: 'text', text: op.text }],
        source: { kind: 'model', provider, model, compactionId } }) },
      { surfaceOp: { op: 'replace', start: op.startSeq, end: op.endSeq },
        sourceEventSeqs: op.shadowedSeqs })

  endSeq = session.append('compaction/end', { compactionId, turn }).seq
  return { compactionId, startSeq, summarySeq, endSeq, summary, … }
```

Wire validity rests on the invariant, not on this file: because every landed
fold is pair-safe, the derived wire always has every `tool_calls` answered by
its `role:tool` entries. Fold-node recognition on later passes is unchanged:
`[Recall id]` header + replacement op, coverage via `sourceEventSeqs`.

## bridge.ts — membrane ↔ ctx.llm (~110 lines)

```
class MembraneBridge:                       // duck-typed Membrane
  constructor({ llm, provider, model, maxTokens?, onText? })

  async complete(request: NormalizedRequest):
    // 1. map messages (1:1 vocab: text↔text, thinking↔reasoning,
    //    tool_use↔tool-call, tool_result↔tool-result; unknown → placeholder)
    // 2. participant mapping: agentParticipant → 'assistant', else 'user';
    //    non-user/agent names keep a "Name: " text prefix
    // 3. splitMixedToolMessages(mapped)        // ← the LIBRARY's helper,
    //                                          //   replaces our hand-rolled split
    // 4. stream:
    usage = null
    for await (chunk of llm.stream({
      provider, model, messages,
      system: request.system,
      tools: request.tools?.map(schemaMapping),   // ← FORWARDED. the refusal
                                                  //   ladder needs them on the wire
      maxTokens: max(request.config.maxTokens, this.maxTokens),
      temperature: request.config.temperature,
      purpose: 'compaction',
    })):
      if chunk.type == 'text-delta': onText?.(chunk.text, false)
      assembler.push(chunk)
    onText?.('', true, assembler.usage)             // terminal flush w/ usage

    // 5. thinking-strip pricing: if thinking+text chars > source chars,
    //    return the response WITHOUT thinking blocks (a fold must never cost
    //    more than the span it replaces) — kept from the old bridge, ~30 lines
    // 6. return membrane response shape { content, rawAssistantText,
    //    stopReason, usage: { inputTokens, outputTokens }, … }
```

## config.ts (~50 lines)

```
Config = z.object({
  operatingWindowTokens: z.number().step(1).min(1).optional(),  // default:
                                     // min(routed window, 65_536)
  reserveTokens:  z.number().step(1).min(0).optional(),         // default 8192
  auto:           z.boolean().optional(),                       // default true
  strategy:       z.looseObject({}).optional(),  // PASSTHROUGH — handed to
                  // AutobiographicalStrategy untouched; upstream knobs flow
                  // with the version bump (kvStableReachTokens,
                  // speculativeProduction, summaryTargetTokens, …)
})
```

Gone vs. today: `storeRoot` (no store), `recentWindowTokens` /
`headWindowTokens` / `maxMessageTokens` / `targetChunkTokens` /
`mergeThreshold` / `maxTokens` / `foldingStrategy` /
`contextWindowTokensByModel` (all live in the `strategy` bag now).
Trade-off: the config catalog's static walk sees only the three harness
knobs; the bag gets a prose note in the README.

## Call-point inventory (who calls what)

| Trigger | Path |
|---|---|
| plugin load | `constructor` → register `agent/pre-step` (if `auto`), `agent/disposed`, dispose effect |
| every agent step | `agent/pre-step` → `foldPass` → sync → `kickTick` (bg) → `feedCalibration` → `compile` → `planFolds` → `applyFolds` |
| `/compact` | `compactNow` → `agent.runMaintenance` → `foldPass` |
| `/autobio` (if kept) | `setAutomaticFolding` → register/remove the pre-step listener |
| memory formation | `manager.tick()` (library) → `bridge.complete()` → `ctx.llm.stream` → mint detected → `autobio/memory` event (with `sourceRange`) |
| session fork | *nothing* — the forked log carries the events; the child's first fold pass seeds from them |
| process restart / kill -9 | *nothing* — next open re-seeds from the log; zero LLM calls |
| `agent/disposed` / shutdown | drop runtime, `manager.close()` — hygiene only |

## Sequence walkthroughs

**Cold open of a long session.** First `agent/pre-step` → `runtimeFor` →
`buildSeededShim` replays N events (~4k surface messages + ~200 summary
events for the red-lemma session; sub-second) → `ContextManager.open` →
strategy `initialize()` reads seeded slots, rebuilds chunk records from L1
`sourceIds` via its lazy-migration path → fold pass proceeds with a complete
pyramid. No LLM calls.

**Steady-state step.** Sync appends the step's new events → background tick
forms at most one memory → calibration fed from the last usage event →
`compile(budget)` commits the frontier → walk usually produces zero ops
(surface already matches) → `next()`.

**Over budget mid-formation.** `compile` throws `OverBudgetError` with
`actual` = measured floor → retry compile at floor+reserve → land that
layout. If even that fails: warn, proceed raw, provider overflow recovery
owns it. The turn NEVER waits on ticks.

**kill -9 at an arbitrary point.** Nothing to do. The shim dies; the log is
untouched; next open is the cold-open path.

**Fork.** Nothing to do. The child's log already contains every
`autobio/memory` event up to the fork point; seeding inherits the pyramid.

## Test plan

1. **Shim conformance**: scripted event log → seed → open → assert
   `summaries`/`messages`/counter contents; open twice, assert byte-identical
   seeds (determinism = the id-injection rule).
2. **Red-lemma replay**: the real 1.27M-event log → seed → `compile` → walk;
   assert the planned folds are consistent with the fold nodes the session
   actually landed (Recall ids match, ranges match).
3. **No-regeneration proof**: mock bridge whose `complete()` throws; kill and
   reopen mid-history; assert zero bridge calls and a working plan.
4. **Pair-safety invariant tests**: scripted surfaces with call/result
   straddles at both boundaries (including sibling-op adjacency); assert the
   widened ranges leave a pair-safe surface, and serialize the result through
   the real `serializeMessages` to prove wire validity. Plus a property test:
   replay real session logs, fold, and assert the surface stays pair-safe.
5. **Bridge**: tools forwarded; `splitMixedToolMessages` applied; thinking
   strip triggers when thinking+text > source.
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
