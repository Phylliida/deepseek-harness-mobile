/**
 * apply wiring on a real cordis Context + SlotRegistry: the timer row waits
 * on the sidebar-declared `sidebar.timer` slot (slots.inject declaration
 * tracking), registers with the persisted store seated and the
 * `coding-timer` locale namespace, and unregisters on fiber teardown.
 * Component behavior is covered props-direct in coding-timer.client.spec.tsx;
 * no renderer machinery here.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { CodingTimer } from '../src/client/CodingTimer.tsx'
import { apply, inject } from '../src/client/index.ts'

/** Boot a context with the slot registry + locale service but no slot declaration. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  return ctx
}

/** Stand in for ui-sidebar's declaring registration. */
function declareTimerSeat(ctx: Context): void {
  ctx.slots.register(
    { name: 'root', children: { 'sidebar.timer': { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-coding-timer apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits until a live entry declares the sidebar.timer slot', async () => {
    ctx = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(0)
    declareTimerSeat(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(1)
  })

  it('registers the row with the persisted store and the locale seat', async () => {
    ctx = await bench()
    declareTimerSeat(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = ctx.slots.entries('sidebar.timer')[0]!
    expect(entry.component).toBe(CodingTimer)
    expect(entry.locale).toBe('coding-timer')
    // The store seat carries the persisted timer state; no inject face.
    expect(entry.store).toBeDefined()
    expect(entry.inject).toBeUndefined()
  })

  it('unregisters the row on fiber teardown', async () => {
    ctx = await bench()
    declareTimerSeat(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(0)
  })
})
