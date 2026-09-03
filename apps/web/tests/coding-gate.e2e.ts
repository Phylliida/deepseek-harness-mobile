/** Focus gate: the stopped coding timer covers the whole UI behind Start Coding. */

import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

describe('web e2e: coding gate', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Opt in to the shipped default-on gate; ordinary scenarios get seeded off.
    scaffold = await launchWebScaffold({ codingGateOn: true })
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

  it('covers the UI while stopped, lifts on Start Coding, and returns on Stop', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-coding-gate'))
    // The cover greets with today's total and the one button; the preference
    // escape hatch ships with it (the Host document is writable here). The
    // gate's dialog landmark keeps its Start apart from the sidebar row's.
    const gate = page.getByRole('dialog', { name: 'Start coding' })
    await gate.waitFor({ timeout: 30_000 })
    await gate.getByText('Coded today').waitFor()
    await gate.getByRole('button', { name: 'Keep the UI always visible' }).waitFor()

    await gate.getByRole('button', { name: 'Start coding' }).click()
    // The gate lifts and the sidebar row takes over with the running readout.
    await page.getByRole('button', { name: /Stop coding/ }).waitFor({ timeout: 10_000 })
    expect(await page.getByRole('dialog', { name: 'Start coding' }).count()).toBe(0)

    await page.getByRole('button', { name: /Stop coding/ }).click()
    await page.getByRole('dialog', { name: 'Start coding' }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the UI visible for the rest of the session once disabled from the cover', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-coding-gate-disable'))
    const gate = page.getByRole('dialog', { name: 'Start coding' })
    await gate.waitFor({ timeout: 30_000 })
    await gate.getByRole('button', { name: 'Keep the UI always visible' }).click()
    // The write round-trips through the Host document and the cover lifts
    // without the timer running.
    await gate.waitFor({ state: 'hidden', timeout: 10_000 })
    // A reload reads the persisted preference: no cover on a stopped timer.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'New Session' }).waitFor({ timeout: 30_000 })
    expect(await page.getByRole('dialog', { name: 'Start coding' }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  })
})
