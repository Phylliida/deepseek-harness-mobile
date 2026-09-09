/**
 * Service provider for the coding-activity seam (`ctx.codingActivity`): one
 * JSON document under the harness home holding the canonical bridged spans
 * (document.ts owns the format and the merge math). Every append re-reads the
 * file inside the cross-process writer lock and replaces it atomically, so
 * two dsh processes or a manual edit interleave with the platform's own
 * writes as merging contributors instead of clobbering. Nothing model-facing
 * reads this log: it is the browser-side wellbeing tracker's shared memory,
 * kept out of the session log by design.
 *
 * @module @deepseek-ai/dsh-coding-activity
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  CODING_ACTIVITY_MAX_FUTURE_SKEW_MS,
  CODING_ACTIVITY_FORMAT_VERSION,
  emptyCodingActivityDocument,
  foldEntry,
  parseCodingActivityDocument,
  type CodingActivityDocument,
  type CodingSpan,
} from './document.ts'
import type { CodingActivityEntry, CodingActivityLog, CodingActivityView } from './types.ts'

export type { CodingActivityEntry, CodingActivityLog, CodingActivityView, CodingSpan } from './types.ts'
export type { CodingActivityDocument } from './document.ts'
export {
  CODING_ACTIVITY_BRIDGE_MS,
  CODING_ACTIVITY_FORMAT_VERSION,
  CODING_ACTIVITY_MAX_FUTURE_SKEW_MS,
  emptyCodingActivityDocument,
  foldEntry,
  mergeSpans,
  parseCodingActivityDocument,
} from './document.ts'

/** Plugin configuration: document location, mirroring the settings provider's. */
export interface Config {
  /** Activity document path; defaults to `coding-activity.json` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/**
 * A batch was refused. Carries the semantic rejections (relative to the Host
 * clock) that wire-type validation cannot express.
 */
export class CodingActivityRejectedError extends Error {
  /**
   * @param message - the concrete reason, safe to surface to the caller.
   */
  constructor(message: string) {
    super(message)
    this.name = 'CodingActivityRejectedError'
  }
}

/** Whether one filesystem error means the document is absent; every other failure surfaces. */
function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether two canonical span lists carry the same content (both sorted by construction). */
function sameSpans(a: readonly CodingSpan[], b: readonly CodingSpan[]): boolean {
  return a.length === b.length && a.every((span, index) => span.start === b[index]?.start && span.end === b[index]?.end)
}

/** File-backed coding-activity log (`coding-activity.json` under the harness home). */
export class CodingActivityFileLog extends Service implements CodingActivityLog {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
  })

  /** Resolved document path (schemastery defaults applied or programmatic fallbacks resolved). */
  private readonly filename: string
  /** Single exclusive operation chain: reads and writes run one at a time in queue order. */
  private tail: Promise<unknown> = Promise.resolve()
  private current: CodingActivityDocument = emptyCodingActivityDocument()
  private loaded = false

  /**
   * @param ctx - provider context.
   * @param config - plugin config; an omitted path resolves to the harness home.
   */
  constructor(ctx: Context, config?: Config) {
    super(ctx, 'codingActivity')
    this.filename = config?.path ?? join(resolveDshHome(config?.dshHome), 'coding-activity.json')
  }

  /** @returns the last loaded view (the initial read forces the first load). */
  read(): Promise<CodingActivityView> {
    return this.enqueue(async () => {
      await this.load()
      return this.view()
    })
  }

  /**
   * Fold the batch in and persist; an append that changes nothing writes
   * nothing, bumps nothing, and emits nothing.
   * @param entry - stamps and/or spans; stamps beyond the future-skew window reject.
   * @returns the view after the fold.
   */
  append(entry: CodingActivityEntry): Promise<CodingActivityView> {
    return this.enqueue(async () => {
      // The clock-relative bound is checked at write time, inside the queue.
      const horizon = Date.now() + CODING_ACTIVITY_MAX_FUTURE_SKEW_MS
      const future = entry.stamps?.find(stamp => stamp > horizon)
      if (future !== undefined) {
        throw new CodingActivityRejectedError(
          `stamp ${String(future)} is more than ${String(CODING_ACTIVITY_MAX_FUTURE_SKEW_MS)}ms ahead of the Host clock`,
        )
      }
      await this.load()
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
      let updated: number | undefined
      await withFileLock(this.filename, async () => {
        // Re-read inside the lock: a concurrent process's write lands inside
        // the fold rather than being replaced by it.
        const fresh = await this.readDocument()
        const spans = foldEntry(fresh.spans, entry)
        if (sameSpans(spans, fresh.spans)) {
          this.current = fresh
          return
        }
        const next: CodingActivityDocument = {
          version: CODING_ACTIVITY_FORMAT_VERSION,
          revision: fresh.revision + 1,
          spans,
        }
        await writeFileAtomic(this.filename, JSON.stringify(next), { mode: 0o600 })
        this.current = next
        updated = next.revision
      })
      if (updated !== undefined) this.emitUpdated(updated)
      return this.view()
    })
  }

  /** @returns the current document as the public view. */
  private view(): CodingActivityView {
    return { revision: this.current.revision, spans: this.current.spans }
  }

  /**
   * Fan the change event out one listener at a time (the plain emit stops at
   * the first throwing listener, starving the rest). Ordinary failures are
   * contained and logged; an INVARIANT-coded failure is harness-fatal and
   * rethrows after every listener ran.
   */
  private emitUpdated(revision: number): void {
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch(
      'emit', ['coding-activity/updated', revision],
    ) as Array<(revision: number) => unknown>) {
      try {
        const returned = listener(revision)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned).then(undefined, (error: unknown) => {
            this.ctx.logger.warn('coding-activity: an activity-updated listener failed: %s', String(error))
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.ctx.logger.warn('coding-activity: an activity-updated listener failed: %s', String(error))
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** First-load the document; an absent file starts empty. */
  private async load(): Promise<void> {
    if (this.loaded) return
    this.current = await this.readDocument()
    this.loaded = true
  }

  /** @returns the on-disk document, the empty one when absent, and loud failures otherwise. */
  private async readDocument(): Promise<CodingActivityDocument> {
    let text: string
    try {
      text = await readFile(this.filename, 'utf8')
    } catch (error) {
      if (isAbsent(error)) return emptyCodingActivityDocument()
      throw error
    }
    const parsed = parseCodingActivityDocument(JSON.parse(text))
    if (parsed === undefined) {
      throw new Error(
        `coding-activity: "${this.filename}" is not a v${String(CODING_ACTIVITY_FORMAT_VERSION)} document`,
      )
    }
    return parsed
  }

  /** Serialize operations so a read can never overtake a queued write. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const raw = this.tail
    const task = raw.then(operation, operation)
    this.tail = task.catch(() => {})
    return task
  }
}

export default CodingActivityFileLog
