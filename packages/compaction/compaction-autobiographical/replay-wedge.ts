/**
 * Scratch diagnostic: replay one session log through the wrapper's own seed +
 * compile + plan path and dump the fold plan, so the live wedge can be
 * reproduced offline. Not a test, not shipped — delete after the investigation.
 *
 * Usage: pnpm tsx replay-wedge.ts [maxSeq]
 */
import { execFileSync } from 'node:child_process'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '@animalabs/context-manager'
import { SessionLogScanner } from '../../session/session-persistence-jsonl/src/format.ts'
import { createStore } from './src/store.ts'
import { seedFromLog, surfaceGround } from './src/seed.ts'
import { foldIdOf, planFolds, priceSurfaceNode } from './src/plan.ts'

const PATH = '/home/bepis/.dsh/sessions/--home-bepis-prog-SimpleBot-repos-self-hosted-creature-collect--/session-d6629d28-6c9c-4b10-ae57-1a4f8698fe3c/session.jsonl.zstd'
const parsed = Number(process.argv[2])
const maxSeq = process.argv[2] === undefined || !Number.isFinite(parsed) ? Infinity : parsed

const raw = execFileSync('zstd', ['-dc', PATH], { maxBuffer: 1 << 30 })
const headerEnd = raw.indexOf(0x0a)
const scanner = new SessionLogScanner(raw.subarray(0, headerEnd + 1))
scanner.write(raw.subarray(headerEnd + 1))
const { meta, events: scanned } = scanner.finish()
const events = scanned.filter(event => event.seq <= maxSeq)
console.log(`events: ${events.length} (truncated at ${maxSeq === Infinity ? 'end' : maxSeq})`)

const session = Session.fromRestore(SessionId(meta.id), events, meta)
if (process.argv.includes('surface')) {
  const coverage = surfaceGround(session)
  for (const seq of session.surface.nodes) {
    const event = events.find(e => e.seq === seq)
    const ground = coverage.get(seq) ?? []
    console.log(`surface node ${seq}: fold=${event ? foldIdOf(event) ?? '-' : '?'} ground=${ground.length} first=[${ground.slice(0, 4).join(',')}]`)
  }
  process.exit(0)
}
const store = createStore()
const seed = seedFromLog(store, session)

const strategy = new AutobiographicalStrategy({
  compressionModel: 'k3-256k',
  summaryParticipant: 'assistant',
  adaptiveResolution: true,
  autoTickOnNewMessage: false,
  foldingStrategy: 'kv-stable',
  carrierPolicy: 'live-strip',
})
const manager = await ContextManager.open({ store: store as never, strategy })

// Approximate the live calibration trajectory: one armed sample per usage event,
// in seq order, the way feedCalibration reports once per pass.
let samples = 0
for (const event of events) {
  if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
  const usage = event.data.usage
  ;(strategy as unknown as { _calibrationArmed: boolean })._calibrationArmed = true
  strategy.reportRealInputTokens(
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
  )
  samples++
}
const calibration = (strategy as unknown as { _calibration: number })._calibration
console.log(`calibration: ${calibration?.toFixed(3)} after ${samples} samples`)

// The live budget: min(262144, 65536) - 8192, reserve 8192.
// argv[3] optionally runs a tight first compile, simulating a committed-L2 era
// before the relaxed retry, so resolution flips across compiles are visible.
const tight = process.argv[3] === undefined ? undefined : Number(process.argv[3])
if (tight !== undefined) {
  try {
    await manager.compile({ maxTokens: tight, reserveForResponse: 8192 })
    console.log(`tight compile at ${tight}: reached`)
  } catch (error: unknown) {
    console.log(`tight compile at ${tight}: ${error instanceof OverBudgetError ? `OverBudgetError actual=${error.actual}` : String(error)}`)
  }
  const committed = (strategy as unknown as { resolutions: Map<string, number> }).resolutions
  const tightHist = new Map<number, number>()
  for (const [id, level] of committed) {
    const seq = seed.seqOf.get(id)
    if (seq === undefined || seq < 7 || seq > 14026) continue
    tightHist.set(level, (tightHist.get(level) ?? 0) + 1)
  }
  console.log(`committed after tight compile, 7..14026: ${[...tightHist].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}:${n}`).join(' ')}`)
}
const budget = { maxTokens: 57344, reserveForResponse: 8192 }
let reached = true
try {
  await manager.compile(budget)
} catch (error: unknown) {
  if (!(error instanceof OverBudgetError)) throw error
  console.log(`compile refused: actual=${error.actual} budget=${error.budget}`)
  const affordable = error.actual + 8192
  try {
    await manager.compile({ maxTokens: affordable, reserveForResponse: 8192 })
  } catch (retry: unknown) {
    if (!(retry instanceof OverBudgetError)) throw retry
    console.log(`retry refused: actual=${retry.actual} budget=${retry.budget}`)
    reached = false
  }
}
console.log(`compile reached: ${reached}`)

// Resolutions among the messages under L1-0's ground (seqs 7..2208) and the
// whole L2-6 ground (7..14026), keyed by level.
const bySeq = new Map<number, string>()
for (const [id, seq] of seed.seqOf) bySeq.set(seq, id)
const hist = (lo: number, hi: number): string => {
  const counts = new Map<number, number>()
  for (let seq = lo; seq <= hi; seq++) {
    const id = bySeq.get(seq)
    if (id === undefined) continue
    const level = (strategy as unknown as { resolutions: Map<string, number> }).resolutions.get(id) ?? 0
    counts.set(level, (counts.get(level) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l}:${n}`).join(' ')
}
console.log(`resolutions 7..2208:   ${hist(7, 2208)}`)
console.log(`resolutions 7..14026:  ${hist(7, 14026)}`)
console.log(`resolutions 14075..33592: ${hist(14075, 33592)}`)

const { resolutions, summaries } = strategy as unknown as {
  resolutions: Map<string, number>
  summaries: Map<string, never>
}
// argv[4]='mix' forces L1-1's run (seqs 2208..3732) to level 1, simulating the
// mixed sticky map the live runtime carries, to reproduce the exact wedge error.
if (process.argv[4] === 'mix') {
  for (const [id, seq] of seed.seqOf) {
    if (seq >= 2208 && seq <= 3732) resolutions.set(id, 1)
  }
  console.log('forced L1 for seqs 2208..3732 (L1-1 run)')
}
const ops = planFolds(store, session, {
  resolutions,
  summaries,
  seeded: seed.known,
  seqOf: seed.seqOf,
  price: priceSurfaceNode,
})
console.log(`plan: ${ops.length} op(s)`)
for (const op of ops) {
  const covered = op.coveredNodes
  console.log(
    `  ${op.summaryId} span=[${op.startSeq}..${op.endSeq}] shadowed=${op.shadowedSeqs.length} tok=${op.shadowedTokens}`
    + ` covered=${covered.length} first=[${covered.slice(0, 6).join(',')}]`
    + ` cites7=${covered.includes(7)}`,
  )
}
const claimants = ops.filter(op => op.coveredNodes.includes(7)).map(op => op.summaryId)
if (claimants.length > 1) console.log(`*** TWO FOLDS CLAIM SURFACE NODE 7: ${claimants.join(', ')}`)
