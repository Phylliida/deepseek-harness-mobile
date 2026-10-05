// Web e2e scenario: the composer's subagent-model seat sets and clears the
// session's delegation route. The gesture rides `session.selectSubagentModel`,
// and the gateway's `session.models` reports the override the delegation seam
// (`subagentModelOverrideFor`) will hand to children that name no explicit route.
// Zero model calls: the switch is llm-domain traffic only, so there is no
// fixture and a stray stream would fail loud because the adapter registry is empty.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ModelSelection } from '@deepseek-ai/dsh-host-apiproxy/api/sessions'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Same two-route catalog the composer-switch scenario declares. */
const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))

describe('web e2e: the composer subagent-model seat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  /** The subagent override the gateway reports for one session, through the real wire face. */
  const subagentOf = async (sessionId: string): Promise<ModelSelection | null> => {
    const response = await scaffold.ctx.apiProxy.sessions.models({
      rpcId: `subagent-model-${sessionId}` as never,
      payload: { sessionId: SessionId(sessionId) },
    })
    if (!response.result.ok) throw new Error(`session.models failed: ${response.result.error.message}`)
    return response.result.value.subagent
  }

  const currentSessionId = async (): Promise<string> => {
    const list = await scaffold.ctx.apiProxy.sessions.list({
      rpcId: 'subagent-model-list' as never,
      payload: {},
    })
    if (!list.result.ok) throw new Error(`session.list failed: ${list.result.error.message}`)
    const current = list.result.value.items[0]
    if (current === undefined) throw new Error('no session after workspace connect')
    return current.sessionId
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'origin-gateway': {
          displayName: 'Origin Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.origin.example/v1',
          models: [{ id: 'origin-large', name: 'Origin Large' }],
        },
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: 'acme-large', name: 'Acme Large' }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The composer's seats only exist once a workspace is connected: without
    // one the input is the locked placeholder and no session scope is open.
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('routes the session\'s delegations to the picked model until the inherit row clears it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-model'))
    const sessionId = await currentSessionId()
    // No override: children inherit the session model.
    expect(await subagentOf(sessionId)).toBeNull()

    const trigger = page.getByRole('button', { name: /^选择子代理模型/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    // The inherit row is the checked default.
    expect(await page.getByRole('menuitemradio', { name: /跟随会话模型/ }).getAttribute('aria-checked'))
      .toBe('true')
    await page.getByRole('menuitemradio', { name: 'Acme Large' }).click()

    await expect.poll(() => subagentOf(sessionId), { timeout: 10_000 })
      .toEqual({ provider: 'acme-gateway', model: 'acme-large' })
    await expect.poll(
      async () => page.getByRole('button', { name: '选择子代理模型，当前 Acme Large' }).isVisible(),
      { timeout: 10_000 },
    ).toBe(true)

    // The inherit row clears the override; the session selection is untouched.
    await trigger.click()
    await page.getByRole('menuitemradio', { name: /跟随会话模型/ }).click()
    await expect.poll(() => subagentOf(sessionId), { timeout: 10_000 }).toBeNull()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
