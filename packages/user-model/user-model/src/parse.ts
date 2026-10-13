/**
 * Parsers for user-model output: the steering reply (completion marker
 * stripped), the JSON question answers, and the JSON approval verdict. All
 * validation failures throw {@link UserModelParseError} so callers fall back
 * to the human instead of guessing.
 *
 * @module @deepseek-ai/dsh-user-model/parse
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { USER_MODEL_COMPLETE_MARKER } from './types.ts'

/** One user-model reply that failed the structured contract. */
export class UserModelParseError extends Error {
  override name = 'UserModelParseError'
}

/** One parsed steering reply. */
export interface UserModelReply {
  /** The reply text with the completion marker stripped; may be empty when the reply was the bare marker. */
  readonly text: string
  /** Whether the reply carried the completion marker. */
  readonly done: boolean
}

/**
 * Parse one steering reply: trim, detect the completion marker as the whole
 * reply or on its own line, and strip it.
 * @param raw - the user-model's raw text output.
 * @returns the deliverable text and the completion flag.
 */
export function parseUserModelReply(raw: string): UserModelReply {
  const trimmed = raw.trim()
  const marker = trimmed.indexOf(USER_MODEL_COMPLETE_MARKER)
  if (marker < 0) return { text: trimmed, done: false }
  const before = trimmed.slice(0, marker).trimEnd()
  const after = trimmed.slice(marker + USER_MODEL_COMPLETE_MARKER.length).trim()
  // The marker ends the reply: it is the whole reply or follows closing
  // feedback on its own trailing line.
  if (after.length > 0) {
    throw new UserModelParseError(`user-model: content follows ${USER_MODEL_COMPLETE_MARKER}`)
  }
  return { text: before, done: true }
}

/** Extract the one JSON object a structured reply carries, tolerating code fences. */
function extractJson(raw: string): unknown {
  const fenced = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new UserModelParseError('user-model: reply carries no JSON object')
  }
  try {
    return JSON.parse(fenced.slice(start, end + 1))
  } catch (error) {
    throw new UserModelParseError(`user-model: reply JSON does not parse: ${(error as Error).message}`)
  }
}

/**
 * Parse and validate the user-model's JSON answers against the question list:
 * every question id exactly once, selected labels drawn from the question's
 * options (when it declares any), single-select enforced.
 * @param raw - the user-model's raw text output.
 * @param questions - the questions the reply must answer.
 * @returns the validated answer in the user-questions wire shape.
 * @throws {@link UserModelParseError} on any contract violation.
 */
export function parseUserModelQuestions(
  raw: string,
  questions: readonly AskUserQuestionItem[],
): AskUserQuestionAnswer {
  const parsed = extractJson(raw)
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { answers?: unknown }).answers)) {
    throw new UserModelParseError('user-model: question reply must be an object with an "answers" array')
  }
  const answers: AskUserQuestionAnswer['answers'] = []
  const seen = new Set<string>()
  for (const item of (parsed as { answers: unknown[] }).answers) {
    if (typeof item !== 'object' || item === null) throw new UserModelParseError('user-model: answer entries must be objects')
    const { id, selected, custom } = item as { id?: unknown; selected?: unknown; custom?: unknown }
    const question = questions.find(q => q.id === id)
    if (question === undefined) throw new UserModelParseError(`user-model: answer for unknown question id "${String(id)}"`)
    if (seen.has(question.id)) throw new UserModelParseError(`user-model: duplicate answer for question "${question.id}"`)
    seen.add(question.id)
    if (!Array.isArray(selected) || selected.some(label => typeof label !== 'string')) {
      throw new UserModelParseError(`user-model: answer for "${question.id}" must carry a "selected" string array`)
    }
    if (question.multiSelect !== true && selected.length > 1) {
      throw new UserModelParseError(`user-model: single-select question "${question.id}" answered with ${selected.length} labels`)
    }
    if (question.options !== undefined) {
      const labels = new Set(question.options.map(option => option.label))
      for (const label of selected as string[]) {
        if (!labels.has(label)) {
          throw new UserModelParseError(`user-model: answer for "${question.id}" selects unknown option "${label}"`)
        }
      }
    }
    answers.push({
      id: question.id,
      selected: selected as string[],
      ...(typeof custom === 'string' && custom.length > 0 ? { custom } : {}),
    })
  }
  for (const question of questions) {
    if (!seen.has(question.id)) throw new UserModelParseError(`user-model: no answer for question "${question.id}"`)
  }
  return { answers }
}

/**
 * Parse the user-model's JSON approval verdict.
 * @param raw - the user-model's raw text output.
 * @returns true to approve, false to reject.
 * @throws {@link UserModelParseError} when the reply carries no boolean verdict.
 */
export function parseUserModelApproval(raw: string): boolean {
  const parsed = extractJson(raw)
  const approved = (parsed as { approved?: unknown }).approved
  if (typeof approved !== 'boolean') {
    throw new UserModelParseError('user-model: approval reply must carry an "approved" boolean')
  }
  return approved
}
