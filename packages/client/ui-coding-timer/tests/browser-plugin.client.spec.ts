/**
 * apply wiring on a real cordis Context + SlotRegistry: the timer row and the
 * gate cover wait on their declaring slots (slots.inject declaration
 * tracking), register sharing ONE persisted store handle, the `coding-timer`
 * locale namespace, and the same settings face (the bound settings scope as
 * the hooks.gate source + the setGate/setIdleMinutes write callbacks), and
 * unregister on fiber teardown. Component behavior is covered props-direct in
 * coding-timer.client.spec.tsx and coding-gate.client.spec.tsx; no renderer
 * machinery here.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CodingGate } from '../src/client/CodingGate.tsx'
import { CodingTimer } from '../src/client/CodingTimer.tsx'
import { apply, inject } from '../src/client/index.ts'
import { CODING_TIMER_SETTINGS_NAMESPACE, CodingTimerSettingsSchema } from '../src/settings.ts'

/** One describe answer with the gate section the scope's decoder accepts. */
function describedGate(gate: boolean) {
  return {
    rpcId: 'coding-timer-spec-0' as never,
    result: {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: CODING_TIMER_SETTINGS_NAMESPACE,
          schema: CodingTimerSettingsSchema.toJSON(),
          value: { gate },
          applies: 'live',
          secrets: [],
          revision: 0,
        }],
      },
    },
  }
}

/**
 * Boot a context with the slot registry, the locale service, and the settings
 * transport chain (connection stub + test remote + the real scope binder),
 * but no slot declarations.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const mutate = vi.fn().mockResolvedValue({
    rpcId: 'coding-timer-spec-1' as never,
    result: {
      ok: true,
      value: {
        ns: CODING_TIMER_SETTINGS_NAMESPACE,
        schema: CodingTimerSettingsSchema.toJSON(),
        value: { gate: false },
        applies: 'live',
        secrets: [],
        revision: 1,
      },
    },
  })
  ctx.provide('connection', {
    api: { settings: { describe: vi.fn().mockResolvedValue(describedGate(true)), mutate } },
    isLoopback: true,
  } as never)
  new TestRemote(ctx)
  await ctx.plugin(SettingsScopeBinder).await()
  return { ctx, mutate }
}

/** Stand in for ui-sidebar's and ui-layout's declaring registrations. */
function declareTimerSeats(ctx: Context): void {
  ctx.slots.register(
    {
      name: 'root',
      children: {
        'sidebar.timer': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never,
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
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('waits until live entries declare the sidebar.timer and shell.overlay slots', async () => {
    ;({ ctx } = await bench())
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(0)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
    declareTimerSeats(ctx)
    await Promise.resolve()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(1)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
  })

  it('registers both surfaces with one shared store, the locale seat, and the settings face', async () => {
    let mutate: ReturnType<typeof vi.fn>
    ;({ ctx, mutate } = await bench())
    declareTimerSeats(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const row = ctx.slots.entries('sidebar.timer')[0]!
    const gate = ctx.slots.entries('shell.overlay')[0]!
    expect(row.component).toBe(CodingTimer)
    expect(gate.component).toBe(CodingGate)
    expect(row.locale).toBe('coding-timer')
    expect(gate.locale).toBe('coding-timer')
    // One persisted store handle across both registrations: the gate reads
    // the same activeSince/sessions the row writes.
    expect(row.store).toBeDefined()
    expect(row.store).toBe(gate.store)
    // The settings face: one shared factory, the settings scope riding the
    // hooks compartment, and the write callbacks as the one mutation path.
    expect(row.inject).toBe(gate.inject)
    const face = (row.inject as (...args: never[]) => Record<string, unknown>)()
    expect(typeof face['setGate']).toBe('function')
    expect(typeof face['setIdleMinutes']).toBe('function')
    const hooks = face['hooks'] as Record<string, unknown>
    const scope = hooks['gate'] as { getSnapshot: () => { value: unknown } }
    // The describe answer carries the pre-idle wire section { gate } only;
    // the scope's decoder defaults idleMinutes into the resolved value.
    await vi.waitFor(() => {
      expect(scope.getSnapshot().value).toEqual({ gate: true, idleMinutes: 10 })
    })
    // setGate writes the gate field through the bound scope's mutation queue.
    ;(face['setGate'] as (on: boolean) => void)(false)
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
        ns: CODING_TIMER_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: ['gate'], value: false }],
      }))
    })
    // setIdleMinutes resolves the user-entered value into the schema bounds
    // before writing (12.6 rounds to 13 rather than riding the wire raw).
    ;(face['setIdleMinutes'] as (minutes: number) => void)(12.6)
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
        ns: CODING_TIMER_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: ['idleMinutes'], value: 13 }],
      }))
    })
  })

  it('unregisters both surfaces on fiber teardown', async () => {
    ;({ ctx } = await bench())
    declareTimerSeats(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(1)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar.timer')).toHaveLength(0)
    expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
