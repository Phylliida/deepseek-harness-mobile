// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AutobioMemoryNodeView } from '../src/client/chat/AutobioMemoryNodeView.tsx'
import { zh } from '../src/client/locales.ts'

let nextAnimationFrameId = 1
let animationFrames = new Map<number, FrameRequestCallback>()

function flushAnimationFrames(count: number): void {
  for (let index = 0; index < count; index += 1) {
    const callbacks = [...animationFrames.values()]
    animationFrames.clear()
    for (const callback of callbacks) callback(index)
  }
}

beforeEach(() => {
  nextAnimationFrameId = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId
    nextAnimationFrameId += 1
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    animationFrames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(zh, commonZh)

/**
 * The row view reads only its Node and the locale seat, so the direct-render
 * seat carries those two and no framework runtime.
 */
function row(text: string, streaming: boolean): Parameters<typeof AutobioMemoryNodeView>[0] {
  return {
    node: {
      key: 'autobio-attempt-1',
      kind: 'autobio-memory',
      id: 'autobio-attempt-1',
      target: 'chat',
      anchorSeq: 10,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { kind: 'autobio-memory', seq: 10, text, streaming },
    },
    t,
  } as unknown as Parameters<typeof AutobioMemoryNodeView>[0]
}

describe('AutobioMemoryNodeView', () => {
  it('previews one line, never the whole recollection, so a forming memory cannot take the screen', () => {
    const view = render(<AutobioMemoryNodeView {...row('I recall the exchange.\nThen I folded it.', true)} />)

    expect(view.getByText('运行中')).toBeTruthy()
    // The line the call has reached, not everything it has written: rendering the
    // full text into the collapsed row is what made a forming memory own the screen.
    expect(view.getByText('Then I folded it.')).toBeTruthy()
    expect(view.queryByText(/I recall the exchange\./)).toBeNull()
  })

  it('follows the streaming line to its end, then rests on the recollection opening line', () => {
    const view = render(<AutobioMemoryNodeView {...row('I recall the exchange.\nThen I folded', true)} />)
    const summary = view.getByText('Then I folded')
    Object.defineProperties(summary, {
      scrollWidth: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 100 },
    })

    view.rerender(<AutobioMemoryNodeView {...row('I recall the exchange.\nThen I folded it', true)} />)
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(2)
    expect(summary.scrollLeft).toBe(0)
    flushAnimationFrames(1)
    expect(summary.scrollLeft).toBe(200)
    expect(summary.getAttribute('data-follow-end')).toBe('true')

    view.rerender(<AutobioMemoryNodeView {...row('I recall the exchange.\nThen I folded it', false)} />)
    flushAnimationFrames(3)
    expect(view.getByText('I recall the exchange.')).toBeTruthy()
    expect(view.queryByText('运行中')).toBeNull()
    expect(summary.scrollLeft).toBe(0)
    expect(summary.hasAttribute('data-follow-end')).toBe(false)
  })

  it('discloses the whole recollection from the row or its preview line', () => {
    const view = render(<AutobioMemoryNodeView {...row('I recall the exchange.\nThen I folded it.', false)} />)
    const disclosure = view.getByRole('button')

    fireEvent.click(view.getByText('I recall the exchange.'))
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Then I folded it\./)).toBeTruthy()

    fireEvent.click(view.getByText('记忆形成'))
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  })

  it('carries no preview line and nothing to disclose for a call that has written nothing yet', () => {
    const view = render(<AutobioMemoryNodeView {...row('', true)} />)

    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByText('记忆形成')).toBeTruthy()
    // Nothing to show and nothing to open, so the row is not an interactive
    // disclosure at all — it is the title saying work is under way.
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[data-expandable]')).toBeNull()
  })
})
