import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef, type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import KimiQuotaService from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Credentials double over one in-memory table. */
class StubCredentials extends CredentialProvider {
  readonly table = new Map<string, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.table.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'stub' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.table.has(ref), writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.table.set(ref, value)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.table.delete(ref)
    return Promise.resolve()
  }
}

async function harness(config?: Record<string, unknown>): Promise<{
  credentials: StubCredentials
  quota: KimiQuotaService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(StubCredentials)
  await ctx.plugin(KimiQuotaService, config)
  return {
    credentials: ctx.get('credentials') as StubCredentials,
    quota: ctx.get('kimiQuota') as KimiQuotaService,
  }
}

const PAYLOAD = {
  usage: { limit: '100', used: '32', resetTime: '2026-08-30T21:24:44Z' },
  limits: [{
    window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', used: '21', resetTime: '2026-08-24T22:24:44Z' },
  }],
  totalQuota: {},
}

function stubPayloadFetch(): void {
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(PAYLOAD),
  }))
}

describe('KimiQuotaService', () => {
  it('publishes one direct current method under the kimiQuota namespace', async () => {
    const { quota } = await harness()
    expect(quota.typertRemote).toMatchObject({ serviceKey: 'kimiQuota', namespace: 'kimiQuota' })
    expect(remoteMethods(quota)).toEqual([{ method: 'current', invocation: { kind: 'direct' } }])
  })

  it('resolves null while the credential is unconfigured', async () => {
    const { quota } = await harness()
    await expect(quota.current()).resolves.toBeNull()
  })

  it('fetches and parses the snapshot with the configured credential', async () => {
    stubPayloadFetch()
    const { credentials, quota } = await harness({ apiKeyEnv: 'KIMI_CODING_API_KEY' })
    credentials.table.set(credentialRef('KIMI_CODING_API_KEY'), 'sk-live')
    const snapshot = await quota.current()
    expect(snapshot).toMatchObject({
      windows: [{ windowMinutes: 300, used: 21, limit: 100 }],
      weekly: { used: 32, limit: 100 },
      monthly: null,
    })
    expect(Date.parse(snapshot!.fetchedAt)).toBeGreaterThan(0)
  })

  it('resolves null when the platform fetch fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const { credentials, quota } = await harness()
    credentials.table.set(credentialRef('KIMI_API_KEY'), 'sk-live')
    await expect(quota.current()).resolves.toBeNull()
  })

  it('rejects a malformed credential reference at load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new KimiQuotaService(ctx, { apiKeyEnv: 'not a ref' })).toThrow(/credential ref/)
  })

  it('falls back to the shipped defaults without a config object', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(StubCredentials)
    const quota = new KimiQuotaService(ctx)
    // No credential named KIMI_API_KEY in this harness: the readout hides.
    await expect(quota.current()).resolves.toBeNull()
  })
})
