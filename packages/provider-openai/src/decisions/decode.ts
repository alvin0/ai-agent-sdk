import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { validateDecisionResult, type DecisionAnswer, type DecisionInput, type DecisionQuestion,
  type DecisionResult } from '@alvin0/ai-agent-sdk-decision-adapter'
import { malformed, object, responseUsage } from './response.ts'

/** A provider refusal is non-retryable and never becomes a fabricated decision answer. */
export const OPENAI_DECISION_REFUSED = 'OPENAI_DECISION_REFUSED'

export function decodeDecision(value: unknown, input: DecisionInput): DecisionResult {
  const raw = object(value), entries = Object.entries(input.questions)
  const source = raw.answers
  if (!Array.isArray(source) || source.length !== entries.length) return malformed('returned an invalid answer count')
  const answers = Object.fromEntries(entries.map(([name, question], index) => {
    const answer = object(source[index])
    if (answer.name !== name) return malformed('returned mismatched answer names or order')
    if (answer.type === 'refusal') throw new ModelError('OpenAI Decisions refused a question', OPENAI_DECISION_REFUSED)
    return [name, decodeAnswer(question, answer)]
  }))
  const usage = responseUsage(raw)
  return validateDecisionResult({ model: raw.model, answers,
    ...(usage === undefined ? {} : { usage }) }, input.questions)
}
function decodeAnswer(question: DecisionQuestion, answer: Record<string, unknown>): DecisionAnswer {
  if (question.type === 'boolean') {
    if (answer.type !== 'predicate' || typeof answer.probability !== 'number') return malformed(
      'returned an invalid predicate')
    return { type: 'boolean', value: answer.probability >= 0.5, probabilityTrue: answer.probability,
      probabilitySource: 'provider' }
  }
  if (answer.type !== question.type || answer.confidence === undefined) return malformed(
    'returned an invalid answer type')
  const probabilities = distribution(answer.probabilities, question)
  const evidence = { probabilities, confidence: answer.confidence as number, probabilitySource: 'provider' as const }
  return question.type === 'choice'
    ? { type: 'choice', choice: answer.choice as string, ...evidence }
    : { type: 'score', score: answer.score as number, ...evidence }
}
function distribution(
  value: unknown, question: Exclude<DecisionQuestion, { type: 'boolean' }>,
): Record<string, number> {
  if (!Array.isArray(value)) return malformed('returned invalid probabilities')
  const expected = question.type === 'choice' ? Object.keys(question.options) : question.levels.map((_, i) => String(i))
  if (value.length !== expected.length) return malformed('returned an invalid probability count')
  const seen = new Set<string>()
  return Object.fromEntries(value.map(raw => {
    const entry = object(raw), key = probabilityKey(entry, question)
    if (!expected.includes(key) || seen.has(key)) return malformed('returned unknown or duplicate probability values')
    seen.add(key)
    return [key, entry.probability as number]
  }))
}
function probabilityKey(entry: Record<string, unknown>, question: DecisionQuestion): string {
  if (question.type === 'choice') {
    if (typeof entry.value !== 'string') return malformed('returned a non-string choice value')
    return entry.value
  }
  if (!Number.isSafeInteger(entry.value) || entry.label !== String(entry.value)) return malformed(
    'returned an invalid score level')
  return String(entry.value)
}
