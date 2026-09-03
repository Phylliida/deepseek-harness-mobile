// @vitest-environment jsdom
// Assembled coding-gate snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless FixtureApiClient transport — but on a REDUCED plugin graph, not the
// shared one in assembled-boot.ts. The gate defaults on whenever its settings
// namespace is absent (the fixture serves only `llm-deepseek`), so adding the
// timer to the shared graph would cover every other assembled snapshot; a
// local graph pins the behavior without touching them. What this file pins:
// stopped boot shows the modal cover (today's total + Start Coding), Start
// lifts it and runs the sidebar row, Stop brings the cover back, and ten idle
// minutes stop a forgotten timer at its last activity.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { WebBootEntry } from '@deepseek-ai/dsh-client-modules/client'
import { installAssembledBootEnv } from './assembled-boot.ts'

/** The reduced gate graph: infrastructure tier verbatim from the shared list, then layout/sidebar/timer. */
const PLUGINS: readonly (WebBootEntry & { bundlePath: string })[] = [
  { id: '@deepseek-ai/dsh-typert-registry', bundlePath: 'packages/typert/registry/lib/client.js', url: '/plugins/typert-registry.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-client-connection', bundlePath: 'packages/client/connection/lib/client.js', url: '/plugins/connection.js', rev: 'fx', inject: [], immediately: true },
  { id: '@deepseek-ai/dsh-api-gateway', bundlePath: 'packages/api/gateway/lib/client.js', url: '/plugins/api-gateway.js', rev: 'fx', inject: ['@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-client-connection'], immediately: true },
  { id: '@deepseek-ai/dsh-api-remotes', bundlePath: 'packages/api/remotes/lib/client.js', url: '/plugins/api-remotes.js', rev: 'fx', inject: ['@deepseek-ai/dsh-api-gateway'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-settings', bundlePath: 'packages/client/ui-settings/lib/client.js', url: '/plugins/ui-settings.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-api-remotes'], immediately: true },
  { id: '@deepseek-ai/dsh-client-runtime', bundlePath: 'packages/client/runtime/lib/client.js', url: '/plugins/runtime.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-theme', bundlePath: 'packages/client/ui-theme/lib/client.js', url: '/plugins/ui-theme.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes'], immediately: true },
  { id: '@deepseek-ai/dsh-client-locale', bundlePath: 'packages/client/locale/lib/client.js', url: '/plugins/locale.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes'], immediately: true },
  { id: '@deepseek-ai/dsh-client-ui-layout', bundlePath: 'packages/client/ui-layout/lib/client.js', url: '/plugins/ui-layout.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-runtime'] },
  { id: '@deepseek-ai/dsh-client-ui-sidebar', bundlePath: 'packages/client/ui-sidebar/lib/client.js', url: '/plugins/ui-sidebar.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-ui-layout'] },
  { id: '@deepseek-ai/dsh-client-ui-coding-timer', bundlePath: 'packages/client/ui-coding-timer/lib/client.js', url: '/plugins/ui-coding-timer.js', rev: 'fx', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar'] },
]

const bundles = new Map(PLUGINS.map(plugin => [
  plugin.url,
  readFileSync(join(process.cwd(), plugin.bundlePath), 'utf8'),
]))

interface FixtureWindow extends Window {
  __DSH_BOOT__?: { rev: string; entries: WebBootEntry[] }
}

const win = window as FixtureWindow

installAssembledBootEnv()

/** The mounted entry, disposed before the shared teardown cleans the DOM (LIFO hook order). */
let entry: AppWebEntry | undefined

afterEach(() => {
  entry?.dispose()
  entry = undefined
})

/** Mount the gate graph on the fixture transport; installAssembledBootEnv's teardown cleans up. */
function mountGateApp(): void {
  history.replaceState(null, '', '/?fixture')
  const root = document.createElement('div')
  root.id = 'root'
  document.body.appendChild(root)
  win.__DSH_BOOT__ = { rev: 'fx', entries: PLUGINS.map(({ bundlePath: _bundlePath, ...plugin }) => plugin) }
  act(() => {
    entry = new AppWebEntry(root, {
      loadBundle: async (url) => {
        const code = bundles.get(url)
        if (code === undefined) throw new Error(`missing built bundle ${url}`)
        ;(0, eval)(code)
      },
    })
    void entry.run()
  })
}

describe('assembled coding gate', () => {
  it('covers the stopped UI, lifts on Start Coding, and returns on Stop', async () => {
    mountGateApp()
    // The fixture serves no coding-timer namespace: the scope reads
    // unavailable, so the shipped default keeps the gate on.
    const gate = await screen.findByRole('dialog', { name: 'Start coding' }, { timeout: 15_000 })
    expect(within(gate).getByText('Coded today')).toBeTruthy()
    expect(within(gate).getByText('0m')).toBeTruthy()

    fireEvent.click(within(gate).getByRole('button', { name: 'Start coding' }))
    // The sidebar row underneath was never unmounted: it takes over running.
    const stop = await screen.findByRole('button', { name: /Stop coding/ }, { timeout: 10_000 })
    expect(screen.queryByRole('dialog', { name: 'Start coding' })).toBeNull()

    fireEvent.click(stop)
    await screen.findByRole('dialog', { name: 'Start coding' }, { timeout: 10_000 })
  })

  it('stops a forgotten timer after ten idle minutes, trimmed to the last activity', async () => {
    mountGateApp()
    const gate = await screen.findByRole('dialog', { name: 'Start coding' }, { timeout: 15_000 })
    fireEvent.click(within(gate).getByRole('button', { name: 'Start coding' }))
    await screen.findByRole('button', { name: /Stop coding/ }, { timeout: 10_000 })

    // Freeze the clock at the start click (fake timers take the real now);
    // the watch armed before the freeze never fires inside the test window.
    vi.useFakeTimers()
    try {
      // Five idle minutes, then one pointer drift re-arms the timeout.
      act(() => { vi.advanceTimersByTime(5 * 60_000) })
      fireEvent.pointerMove(window)
      act(() => { vi.advanceTimersByTime(10 * 60_000 - 1_000) })
      // 9:59 past the drift: still running, still no cover.
      expect(screen.queryByRole('dialog', { name: 'Start coding' })).toBeNull()
      act(() => { vi.advanceTimersByTime(2_000) })
      // Stopped at the drift (5 minutes in), not at the fire instant: the
      // returning cover's today total is the trimmed stretch.
      const cover = screen.getByRole('dialog', { name: 'Start coding' })
      expect(within(cover).getByText('5m')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
