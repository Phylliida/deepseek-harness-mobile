/** Idle cover: after idle minutes without input, the whole UI hides behind today's total; any interaction lifts it again. */

import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** Idle delay seeded into the scenario, short enough to cross inside a test. */
const IDLE_MINUTES = 1

describe('web e2e: coding gate', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Opt in to the shipped default-on cover with a one-minute idle delay;
    // ordinary scenarios get the cover seeded off.
    scaffold = await launchWebScaffold({ codingGateOn: true, codingGateIdleMinutes: IDLE_MINUTES })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('covers after idle minutes, lifts on any interaction, and shows live totals', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-coding-gate'))
    // Boot counts as arrival: the UI starts open and the cover waits out the
    // first idle stretch.
    await page.getByRole('button', { name: 'New Session' }).waitFor({ timeout: 30_000 })

    // Touching the app records activity on the shared log.
    await page.mouse.move(400, 300)
    await page.mouse.move(200, 300)
    await page.getByRole('button', { name: 'Coding time stats' }).click()
    const modal = page.getByRole('dialog', { name: 'Coding time stats' })
    await modal.waitFor({ timeout: 10_000 })
    // A few seconds of recorded activity still totals zero displayed minutes.
    await modal.getByText('0m').first().waitFor()
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'hidden', timeout: 10_000 })

    // Standing back: after the idle minute the cover arrives with the same
    // total and the return hint.
    const cover = page.getByRole('dialog', { name: 'Coded today' })
    await cover.waitFor({ timeout: (IDLE_MINUTES + 1) * 60_000 })
    await cover.getByText('0m').waitFor()
    await cover.getByText('Move the mouse or press a key to return').waitFor()

    // Any interaction lifts it — even a pointer move over the cover itself.
    await page.mouse.move(600, 400)
    await cover.waitFor({ state: 'hidden', timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, (IDLE_MINUTES + 3) * 60_000)

  it('keeps the UI visible for the rest of the session once disabled from the cover', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-coding-gate-disable'))
    const cover = page.getByRole('dialog', { name: 'Coded today' })
    await cover.waitFor({ timeout: (IDLE_MINUTES + 1) * 60_000 })
    await cover.getByRole('button', { name: 'Keep the UI always visible' }).click()
    // The write round-trips through the Host document and the cover lifts.
    await cover.waitFor({ state: 'hidden', timeout: 10_000 })
    // A reload reads the persisted preference: no cover even after idling.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'New Session' }).waitFor({ timeout: 30_000 })
    await page.waitForTimeout((IDLE_MINUTES + 1) * 60_000)
    expect(await page.getByRole('dialog', { name: 'Coded today' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, (IDLE_MINUTES + 3) * 60_000)
})
