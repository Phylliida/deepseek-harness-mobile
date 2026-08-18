// @vitest-environment jsdom
// ui-cost-estimate apply wiring: dictionary registration, dock line
// registration ahead of the stats row, and registration disposal.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'

// The assertions read the shipped Chinese copy; state the browser they assume.
usePinnedBrowserLanguages('zh-CN')
import { apply, inject, NS } from '@deepseek-ai/dsh-client-ui-cost-estimate/client'
// Type-only: merges the composer dock key into SlotMap for entries()/register.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CostLine, type CostLineInjected } from '../src/client/CostLine.tsx'

const SLOT = 'conversation.composer.dock'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('connection', {
    api: { settings: { describe: () => Promise.resolve({
      rpcId: 'cost-describe' as never,
      result: { ok: true, value: { writable: true, hasDocument: false, namespaces: [] } },
    }) } },
    isLoopback: true,
  } as never)
  // The scope's transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin(SettingsScopeBinder).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** Stand in for the composer: declare the dock slot from root. */
function declareDock(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'session' } } } as never,
    () => null,
  )
}

describe('ui-cost-estimate apply', () => {
  it('declares the slots/locale/settings-transport edges', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('registers localized copy and the dock line ahead of the stats row', async () => {
    const b = await bench()
    declareDock(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.locale.bind(NS)('line', { cost: '~$1', percent: ' (0.8%)' })).toBe('预估费用 ~$1 (0.8%)')
    expect(b.locale.bind(NS)('budget', { budget: '$120', percent: '0.8%' })).toBe('约占每周预算（$120）的 0.8%')
    b.locale.setLocale('en')
    expect(b.locale.bind(NS)('line', { cost: '~$1', percent: ' (0.8%)' })).toBe('est. cost ~$1 (0.8%)')
    expect(b.locale.bind(NS)('budget', { budget: '$120', percent: '0.8%' })).toBe('about 0.8% of the $120 weekly budget')
    const entry = b.slots.entries(SLOT).find(e => e.component === CostLine)!
    expect(entry.options).toMatchObject({ id: 'cost', order: -1 })
    expect(entry.locale).toBe(NS)
  })

  it('registers the line when the dock declaration arrives after apply', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    declareDock(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT).some(e => e.component === CostLine)).toBe(true)
  })

  it('hands the injected rates source to the line and disposes it with the fiber', async () => {
    const b = await bench()
    declareDock(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries(SLOT).find(e => e.component === CostLine)!
    const face = (entry.inject as unknown as () => CostLineInjected)()
    const settings = face.hooks.settings
    // No Host section: the schema defaults feed the line.
    expect(settings.getSnapshot()).toEqual({
      rates: { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 },
      weeklyBudgetUsd: 120,
    })
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
  })
})
