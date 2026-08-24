/** Node half: deliberately empty — the timer is a browser-only surface. */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-coding-timer node plugin', () => {
  it('mounts nothing host-side', () => {
    apply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
