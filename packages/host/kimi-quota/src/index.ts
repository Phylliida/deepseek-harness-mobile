/**
 * Kimi Code subscription quota Remote: `kimiQuota/current` fetches the managed
 * platform's `/usages` endpoint with the configured credential and returns the
 * parsed allowance rows. The service is deliberately stateless — no cache, no
 * poller, no event stream — so every call reports what the platform reports,
 * and the Client readout owns refresh cadence.
 *
 * @module @deepseek-ai/dsh-host-kimi-quota
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { fetchKimiUsage } from './usage.ts'
import type { KimiQuotaSnapshot } from './types.ts'

export type * from './types.ts'
export { fetchKimiUsage, parseKimiUsagePayload } from './usage.ts'
export type { KimiQuotaPayload, KimiUsageFetch } from './usage.ts'

/** Deployment knobs for the quota fetcher. */
export interface Config {
  /** Managed platform base URL (default `https://api.kimi.com/coding`); `/v1/usages` is appended. */
  baseUrl?: string
  /** Credential reference (environment-variable name) holding the Kimi Code API key. */
  apiKeyEnv?: string
  /** `/usages` request timeout in milliseconds (default 8000). */
  timeoutMs?: number
}

/** Remote-only service exposing the Kimi Code subscription quota snapshot. */
export class KimiQuotaService extends TypertRemoteService {
  static inject = ['credentials']

  static Config: z<Config> = z.object({
    baseUrl: z.string().default('https://api.kimi.com/coding'),
    apiKeyEnv: z.string().default('KIMI_API_KEY'),
    timeoutMs: z.number().default(8_000),
  })

  private readonly baseUrl: string
  private readonly apiKeyEnv: CredentialRef
  private readonly timeoutMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'kimiQuota')
    this.baseUrl = (config.baseUrl ?? 'https://api.kimi.com/coding').replace(/\/+$/, '')
    // credentialRef validates the reference at load, so a malformed
    // environment-variable name fails here rather than on the first call.
    this.apiKeyEnv = credentialRef(config.apiKeyEnv ?? 'KIMI_API_KEY')
    this.timeoutMs = config.timeoutMs ?? 8_000
  }

  /**
   * Fetch the current subscription quota from the platform.
   * @returns the parsed snapshot, or `null` while the credential is
   * unconfigured or the platform cannot be reached — the readout degrades to
   * hiding the quota segment instead of surfacing a fetch failure per render.
   */
  @Remote('current')
  async current(): Promise<KimiQuotaSnapshot | null> {
    const credential = await this.ctx.credentials.resolve(this.apiKeyEnv)
    if (credential === undefined) return null
    let payload
    try {
      payload = await fetchKimiUsage(this.baseUrl, credential.value, this.timeoutMs)
    } catch {
      // Swallows only the fetchKimiUsage rejection (transport, timeout, non-2xx):
      // every one of them means the platform quota is currently unreadable.
      return null
    }
    return { fetchedAt: new Date().toISOString(), ...payload }
  }
}

export default KimiQuotaService
