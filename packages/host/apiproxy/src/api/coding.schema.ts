/**
 * coding domain zod schemas (names derived from map keys: codingReadRequestSchema /
 * codingReadValueSchema / codingWrite*). The span-count bound keeps one request
 * under the connection's body limit; the stamp-count bound follows from the
 * source's throttle (one stamp per second, batches of a few seconds).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { CodingSpanView } from './coding.ts'

/** One activity batch's stamp bound: an hour of continuous input in one write. */
export const CODING_WRITE_STAMPS_MAX = 3600

/** One activity batch's span bound: a decade of daily migration sessions per write. */
export const CODING_WRITE_SPANS_MAX = 10_000

/** One coding stretch. */
export const codingSpanViewSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<CodingSpanView>>

/** CodingActivityLogView row of coding.read and the write response. */
export const codingActivityLogViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  spans: z.array(codingSpanViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'coding.read'>>>

/** coding.read request payload. */
export const codingReadRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'coding.read'>>>

/** coding.read response value. */
export const codingReadValueSchema = codingActivityLogViewSchema

/** coding.write request payload: stamps and/or whole spans, at least one present. */
export const codingWriteRequestSchema = z.object({
  stamps: z.array(z.number().int().nonnegative()).max(CODING_WRITE_STAMPS_MAX).optional(),
  spans: z.array(codingSpanViewSchema).max(CODING_WRITE_SPANS_MAX).optional(),
}).refine(batch => batch.stamps !== undefined || batch.spans !== undefined, {
  message: 'coding.write requires stamps and/or spans',
}) satisfies z.ZodType<Wire<RequestPayload<'coding.write'>>>

/** coding.write response value: the view after the fold. */
export const codingWriteValueSchema = codingActivityLogViewSchema
