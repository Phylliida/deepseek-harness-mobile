/**
 * Coding-activity domain of the host ApiProxy: an absent provider answers an
 * actionable internal error, `coding.write` folds batches through the
 * provider and returns the view, a provider refusal maps to
 * `coding-rejected`, and the provider's change event forwards verbatim as a
 * `host/remote-event` frame so every connected browser can re-read.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { CodingActivityLog, CodingActivityView } from '@deepseek-ai/dsh-coding-activity/types'
import type { HostFrame, RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const DEFAULTS = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

/** The proxy's standing service spine. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Mount the in-memory provider on the harness's context. */
function mountLog(ctx: Context, failWrites?: string): MemoryCodingActivity {
  const log = new MemoryCodingActivity(ctx, ...failWrites === undefined ? [] : [failWrites])
  ctx.provide('codingActivity', log)
  return log
}

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`req-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function expectErr<T>(response: RpcResponse<T>): { code: string; message: string; details: unknown } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('unreachable')
  return response.result.error
}

/** In-memory coding-activity provider with emission, mirroring the file log's contract. */
class MemoryCodingActivity implements CodingActivityLog {
  private revision = 0
  private spans: { start: number; end: number }[] = []

  constructor(private readonly ctx: Context, private readonly failWrites?: string) {}

  read(): Promise<CodingActivityView> {
    return Promise.resolve({ revision: this.revision, spans: this.spans })
  }

  append(entry: { stamps?: number[]; spans?: { start: number; end: number }[] }): Promise<CodingActivityView> {
    if (this.failWrites !== undefined) return Promise.reject(new Error(this.failWrites))
    this.revision += 1
    this.spans = [...this.spans, ...(entry.spans ?? []), ...(entry.stamps ?? []).map(stamp => ({ start: stamp, end: stamp }))]
      .sort((a, b) => a.start - b.start)
    this.ctx.events.emit('coding-activity/updated', this.revision)
    return this.read()
  }
}

describe('coding domain', () => {
  it('reports an actionable error when no provider is mounted', async () => {
    const ctx = await harness()
    const api = createApiProxy(ctx, DEFAULTS)
    const read = expectErr(await api.coding.read(request({})))
    expect(read.code).toBe('internal')
    expect(read.message).toContain('dsh-coding-activity')
    const write = expectErr(await api.coding.write(request({ stamps: [0] })))
    expect(write.code).toBe('internal')
  })

  it('reads and writes through the provider', async () => {
    const ctx = await harness()
    mountLog(ctx)
    const api = createApiProxy(ctx, DEFAULTS)
    expect(await expectOk(await api.coding.read(request({}))).revision).toBe(0)
    const view = expectOk(await api.coding.write(request({ stamps: [60_000] })))
    expect(view.revision).toBe(1)
    expect(view.spans).toEqual([{ start: 60_000, end: 60_000 }])
    const migrated = expectOk(await api.coding.write(request({ spans: [{ start: 0, end: 30_000 }] })))
    expect(migrated.spans).toEqual([{ start: 0, end: 30_000 }, { start: 60_000, end: 60_000 }])
  })

  it('maps a provider refusal to coding-rejected', async () => {
    const ctx = await harness()
    mountLog(ctx, 'stamp beyond the future-skew window')
    const api = createApiProxy(ctx, DEFAULTS)
    const error = expectErr(await api.coding.write(request({ stamps: [0] })))
    expect(error.code).toBe('coding-rejected')
    expect(error.message).toContain('future-skew')
  })

  it('forwards coding-activity/updated verbatim on the host stream', async () => {
    const ctx = await harness()
    mountLog(ctx)
    // Host-stream opener reads the committed-workspace baseline; the stub suffices.
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    const api = createApiProxy(ctx, DEFAULTS)
    const abort = new AbortController()
    const frames: HostFrame[] = []
    const consume = (async () => {
      for await (const frame of api.events.host(request({}), abort.signal)) {
        frames.push(frame.payload)
        if (frames.some(candidate => candidate.type === 'host/remote-event' && candidate.event === 'coding-activity/updated')) {
          abort.abort()
        }
      }
    })()
    await api.coding.write(request({ stamps: [42] }))
    await consume
    expect(frames).toContainEqual({
      type: 'host/remote-event',
      event: 'coding-activity/updated',
      args: [1],
    })
  })
})
