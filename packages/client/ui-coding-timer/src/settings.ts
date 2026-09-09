/**
 * The coding timer's Host user-settings section: the idle cover's on/off
 * preference and the idle minutes that bring it, shared by the Host
 * namespace registration (src/index.ts) and the browser settings scope
 * (src/client/). The interaction history itself is the shared activity log
 * (dsh-coding-activity's document, cross-device by design); these
 * preferences are the smaller Host-side state every loopback browser pointed
 * at one deployment agrees on.
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the coding timer plugin. */
export const CODING_TIMER_SETTINGS_NAMESPACE = 'coding-timer'

/** Field carrying the idle-cover preference. */
export const CODING_TIMER_GATE_FIELD = 'gate'

/** Field carrying the idle delay that covers the UI, in whole minutes. */
export const CODING_TIMER_IDLE_FIELD = 'idleMinutes'

/**
 * Default when the user-settings document has no opinion: the cover shows
 * after idle minutes without input. The product default is the guarded one —
 * a missing setting must never silently disable the wellbeing surface.
 */
export const DEFAULT_GATE = true

/**
 * Default idle cover delay in minutes: no input activity for this long
 * brings the cover back; any interaction lifts it.
 */
export const DEFAULT_IDLE_MINUTES = 2

/** Shortest accepted idle timeout, in minutes. */
export const IDLE_MINUTES_MIN = 1
/** Longest accepted idle timeout, in minutes (8 hours). */
export const IDLE_MINUTES_MAX = 480

/** Durable coding-timer section shared by the Host schema and the browser scope. */
export interface CodingTimerSettings {
  /** Whether idle minutes without input cover the UI behind the start screen. */
  [CODING_TIMER_GATE_FIELD]: boolean
  /** Idle minutes that bring the cover. */
  [CODING_TIMER_IDLE_FIELD]: number
}

/** Durable section schema; the browser scope's wire validation reuses it. */
export const CodingTimerSettingsSchema: z<CodingTimerSettings> = z.object({
  [CODING_TIMER_GATE_FIELD]: z.boolean().default(DEFAULT_GATE),
  [CODING_TIMER_IDLE_FIELD]: z.number().step(1).min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX).default(DEFAULT_IDLE_MINUTES),
})

/** Whether one wire value is an in-range whole-minute idle timeout. */
function isIdleMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= IDLE_MINUTES_MIN && value <= IDLE_MINUTES_MAX
}

/**
 * Narrow one wire section to the timer's preferences. Supplied as the
 * scope's `decode` so the browser never depends on the schema-form wire
 * envelope. Each field defaults independently, so a section written before
 * the idle field existed still decodes; a section carrying neither field is
 * no opinion at all and keeps the last accepted value.
 * @param section - value crossing the settings wire boundary.
 * @returns the section with any absent field defaulted, else undefined.
 */
export function decodeCodingTimerSettings(section: unknown): CodingTimerSettings | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const record = section as Record<string, unknown>
  const gate = record[CODING_TIMER_GATE_FIELD]
  const idle = record[CODING_TIMER_IDLE_FIELD]
  if (typeof gate !== 'boolean' && !isIdleMinutes(idle)) return undefined
  return {
    [CODING_TIMER_GATE_FIELD]: typeof gate === 'boolean' ? gate : DEFAULT_GATE,
    [CODING_TIMER_IDLE_FIELD]: isIdleMinutes(idle) ? idle : DEFAULT_IDLE_MINUTES,
  }
}

/**
 * Resolve one user-entered minutes value to a writable idle timeout: finite
 * values round and clamp into the schema's bounds, anything else reverts to
 * the default. The one resolve point for the modal's free-typed input, so
 * the scope write never carries a value the Host schema would reject.
 * @param minutes - the raw value from the settings control.
 * @returns an in-range whole-minute timeout.
 */
export function clampIdleMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_IDLE_MINUTES
  return Math.min(IDLE_MINUTES_MAX, Math.max(IDLE_MINUTES_MIN, Math.round(minutes)))
}
