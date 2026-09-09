/**
 * displaySpans projection spec: pending stamps fold through the canonical
 * bridge merge, a render instant inside the tail's bridge window extends the
 * live tail, one past it does not, and a clock-skewed instant before the tail
 * leaves the span alone.
 */
import { describe, expect, it } from 'vitest'
import { displaySpans } from '../src/client/bridging.ts'

const M = 60_000

describe('displaySpans', () => {
  it('extends the tail to the render instant inside the bridge window', () => {
    const d = displaySpans({ spans: [{ start: 0, end: M }], pendingStamps: [] }, M + 30_000)
    expect(d.live).toBe(true)
    expect(d.spans).toEqual([{ start: 0, end: M + 30_000 }])
  })

  it('does not extend a tail whose bridge window has closed', () => {
    const d = displaySpans({ spans: [{ start: 0, end: M }], pendingStamps: [] }, 4 * M)
    expect(d.live).toBe(false)
    expect(d.spans).toEqual([{ start: 0, end: M }])
  })

  it('folds pending stamps as bridge anchors before judging live', () => {
    // 3 min bridges to the 1.5-min stamp, so the whole run reads as one span
    // extended to the live render instant.
    const d = displaySpans({
      spans: [{ start: 0, end: M }],
      pendingStamps: [M + 30_000, 3 * M],
    }, 4 * M)
    expect(d.live).toBe(true)
    expect(d.spans).toEqual([{ start: 0, end: 4 * M }])
  })

  it('reports not-live with an empty log and extends nothing', () => {
    const d = displaySpans({ spans: [], pendingStamps: [] }, 10 * M)
    expect(d).toEqual({ spans: [], live: false })
  })

  it('leaves the tail alone when now precedes it (clock skew)', () => {
    const d = displaySpans({ spans: [{ start: 0, end: M }], pendingStamps: [] }, M - 1)
    expect(d.live).toBe(false)
    expect(d.spans).toEqual([{ start: 0, end: M }])
  })
})
