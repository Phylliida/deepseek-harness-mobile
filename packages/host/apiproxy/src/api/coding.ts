/**
 * coding domain contract: the web face of the cross-device coding-activity
 * log (`ctx.codingActivity`). The log is the wellbeing tracker's private
 * record — interaction stamps carry no payload beyond the instant, which is
 * why this pair is NOT pinned loopback-only: a LAN client writes exactly the
 * data it generates, and reading it returns no more than the writer's own
 * collective history.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One coding stretch (epoch ms), matching the activity log's canonical span. */
export interface CodingSpanView {
  /** First interaction of the run (epoch ms). */
  start: number
  /** Last interaction of the run (epoch ms); equals `start` for a lone stamp. */
  end: number
}

/** Wire view of the activity log: the revisioned span list. */
export interface CodingActivityLogView {
  /** Monotonic revision the view was read at; concurrent writers never see a stale write's id. */
  revision: number
  /** Canonical bridge-merged spans (ascending; adjacent gaps are never under the two-minute bridge). */
  spans: CodingSpanView[]
}

/** coding-domain unary methods (the map keys coding.* of RpcMethodMap). */
export interface CodingApi {
  /**
   * Read the shared activity log. Every connected browser reads the same
   * document; the forwarded `coding-activity/updated` event announces a
   * revision worth re-reading.
   */
  read(request: RpcRequest<{}>): Promise<RpcResponse<CodingActivityLogView>>

  /**
   * Fold one batch into the log: interaction `stamps` (epoch ms, throttled at
   * source), and/or whole `spans` (the legacy localStorage migration's
   * completed sessions). Stamps more than the provider's future-skew window
   * ahead of the Host clock reject as `coding-rejected`; the response carries
   * the view after the fold.
   */
  write(request: RpcRequest<{ stamps?: number[]; spans?: CodingSpanView[] }>): Promise<RpcResponse<CodingActivityLogView>>
}
