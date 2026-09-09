// @vitest-environment jsdom
// Assembled coding-gate snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless FixtureApiClient transport — but on a REDUCED plugin graph, not the
// shared one in assembled-boot.ts. The cover defaults on whenever its settings
// namespace is absent (the fixture serves only `llm-deepseek`), so adding the
// timer to the shared graph would cover every other assembled snapshot; a
// local graph pins the behavior without touching them. What this file pins:
// boot leaves the UI open for the idle-delay window, the modal cover arrives
// after idle minutes with today's total and the return hint, ANY interaction
// lifts it again, and a later idle stretch covers again — the fixture's
// shared-log double is what the totals read.
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

/** Idle delay the shipped default arms (two minutes), plus margin. */
const IDLE_MARGIN_MS = 2 * 60_000 + 1_000

describe('assembled coding gate', () => {
  it('covers after idle minutes, lifts on any interaction, and covers again after more idle', async () => {
    mountGateApp()
    // Boot counts as arrival: the app opens uncovered and the row is up.
    await screen.findByRole('button', { name: 'New Session' }, { timeout: 15_000 })
    expect(screen.queryByRole('dialog', { name: 'Coded today' })).toBeNull()

    // One real interaction restamps the local idle clock, then the clock is
    // frozen so the idle boundary is exactly testable.
    fireEvent.pointerMove(window)
    vi.useFakeTimers()
    try {
      act(() => { vi.advanceTimersByTime(IDLE_MARGIN_MS) })
      const cover = screen.getByRole('dialog', { name: 'Coded today' })
      expect(within(cover).getByText('0m')).toBeTruthy()
      expect(within(cover).getByText('Move the mouse or press a key to return')).toBeTruthy()

      // Any interaction lifts the cover — even a bare pointer drift.
      fireEvent.pointerMove(window)
      expect(screen.queryByRole('dialog', { name: 'Coded today' })).toBeNull()

      // Idling beyond the delay covers again: the cover is the standing idle
      // state, not a one-shot.
      act(() => { vi.advanceTimersByTime(IDLE_MARGIN_MS) })
      expect(screen.getByRole('dialog', { name: 'Coded today' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
