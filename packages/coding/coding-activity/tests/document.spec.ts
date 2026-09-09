import { describe, expect, it } from 'vitest'
import {
  CODING_ACTIVITY_BRIDGE_MS,
  emptyCodingActivityDocument,
  foldEntry,
  mergeSpans,
  parseCodingActivityDocument,
} from '../src/document.ts'

const M = 60_000

describe('mergeSpans', () => {
  it('merges overlaps and bridge gaps, keeping strict two-minute gaps disjoint', () => {
    // Tap stamps at whole minutes 1..11 (user's example): totals 1 + 2 + 1.
    const stamps = [1, 2, 5, 6, 7, 10, 11].map(minute => ({ start: minute * M, end: minute * M }))
    expect(mergeSpans(stamps)).toEqual([
      { start: 1 * M, end: 2 * M },
      { start: 5 * M, end: 7 * M },
      { start: 10 * M, end: 11 * M },
    ])
  })

  it('does not merge a gap of exactly the bridge width', () => {
    expect(mergeSpans([
      { start: 0, end: 0 },
      { start: CODING_ACTIVITY_BRIDGE_MS, end: CODING_ACTIVITY_BRIDGE_MS },
    ])).toEqual([
      { start: 0, end: 0 },
      { start: CODING_ACTIVITY_BRIDGE_MS, end: CODING_ACTIVITY_BRIDGE_MS },
    ])
  })

  it('merges a gap one millisecond under the bridge width', () => {
    expect(mergeSpans([
      { start: 0, end: 0 },
      { start: CODING_ACTIVITY_BRIDGE_MS - 1, end: CODING_ACTIVITY_BRIDGE_MS - 1 },
    ])).toEqual([{ start: 0, end: CODING_ACTIVITY_BRIDGE_MS - 1 }])
  })

  it('is commutative across concurrent devices\' arrival orders', () => {
    const a = [{ start: 0, end: M }, { start: 3 * M, end: 3 * M }]
    const b = [{ start: 2 * M, end: 2 * M }, { start: 4 * M, end: 5 * M }]
    const first = mergeSpans(mergeSpans(a).concat(b))
    expect(mergeSpans([...b, ...a])).toEqual(first)
    expect(first).toEqual([{ start: 0, end: 5 * M }])
  })

  it('sorts, clamps inverted spans, and contains stamps inside a span', () => {
    expect(mergeSpans([
      { start: 10 * M, end: 12 * M },
      { start: 11 * M, end: 11 * M },
      { start: 5 * M, end: 4 * M },
    ])).toEqual([
      { start: 5 * M, end: 5 * M },
      { start: 10 * M, end: 12 * M },
    ])
  })
})

describe('foldEntry', () => {
  it('extends a tail span from a stamp inside the bridge window', () => {
    expect(foldEntry([{ start: 0, end: M }], { stamps: [M + 30_000] }))
      .toEqual([{ start: 0, end: M + 30_000 }])
  })

  it('keeps a lone stamp as a zero-length anchor span', () => {
    expect(foldEntry([], { stamps: [M] })).toEqual([{ start: M, end: M }])
  })

  it('merges whole spans against existing ones out of order', () => {
    expect(foldEntry([{ start: 10 * M, end: 11 * M }], { spans: [{ start: 0, end: M }] })).toEqual([
      { start: 0, end: M },
      { start: 10 * M, end: 11 * M },
    ])
  })

  it('folds stamps and spans from one entry together', () => {
    expect(foldEntry([], { stamps: [M], spans: [{ start: M + 30_000, end: 2 * M }] }))
      .toEqual([{ start: M, end: 2 * M }])
  })
})

describe('parseCodingActivityDocument', () => {
  it('round-trips the empty document', () => {
    expect(parseCodingActivityDocument(JSON.parse(JSON.stringify(emptyCodingActivityDocument()))))
      .toEqual(emptyCodingActivityDocument())
  })

  it('accepts a populated document', () => {
    const value = { version: 1, revision: 3, spans: [{ start: 0, end: 5 }] }
    expect(parseCodingActivityDocument(value)).toEqual(value)
  })

  it('rejects non-v1 markers, bad revisions, and malformed spans', () => {
    expect(parseCodingActivityDocument(null)).toBeUndefined()
    expect(parseCodingActivityDocument([])).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 2, revision: 0, spans: [] })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: -1, spans: [] })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: 0, spans: {} })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: 0, spans: [null] })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: 0, spans: [{ start: 'x', end: 1 }] })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: 0, spans: [{ start: -1, end: 0 }] })).toBeUndefined()
    expect(parseCodingActivityDocument({ version: 1, revision: 0, spans: [{ start: 2, end: 1 }] })).toBeUndefined()
  })
})
