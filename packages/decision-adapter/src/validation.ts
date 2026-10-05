import { ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import type { DecisionCapabilities, DecisionInput, DecisionModelInfo, DecisionQuestions, DecisionResult } from './types.ts'

const encoder = new TextEncoder()
interface JsonSize { readonly bytes: number; readonly nodes: number; readonly depth: number }
// Only SDK-created, deeply frozen snapshots qualify. Object.freeze on caller data is insufficient.
const jsonSnapshots = new WeakMap<object, JsonSize>()
const questionSnapshots = new WeakMap<object, { readonly size: JsonSize; readonly counts: readonly { type: string; count: number }[] }>()
const inputSnapshots = new WeakSet<object>()
const resultSnapshots = new WeakMap<object, DecisionQuestions>()
const sizeOf = (value: unknown): JsonSize => typeof value === 'object' && value !== null
  ? jsonSnapshots.get(value)!
  : { bytes: encoder.encode(JSON.stringify(value)).byteLength, nodes: 1, depth: 0 }

export function decisionError(message: string, response = false): never {
  throw new ModelError(message, response ? MODEL_ERROR_CODES.MALFORMED_RESPONSE : MODEL_ERROR_CODES.INVALID_REQUEST)
}
export function record(value: unknown, label: string, response = false): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    decisionError(`${label} must be an object`, response)
  }
  return value as Record<string, unknown>
}
export function identifier(value: unknown, label: string, response = false): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) decisionError(`${label} must be a non-empty identifier`, response)
  return value
}
/** Validate JSON before serialization, rejecting lossy values and cyclic inputs. */
export function snapshotJson<T>(value: T, maxBytes = 2_097_152): T {
  const known = typeof value === 'object' && value !== null ? jsonSnapshots.get(value) : undefined
  if (known) {
    if (known.bytes > maxBytes) decisionError('Decision JSON exceeds byte limit')
    return value
  }
  const seen = new Set<object>()
  let nodes = 0
  let maxDepth = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) decisionError('Decision JSON exceeds structural limits')
    maxDepth = Math.max(maxDepth, depth)
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null || seen.has(item)) decisionError('Decision input must be finite, acyclic JSON')
    seen.add(item)
    let copied: unknown
    if (Array.isArray(item)) copied = Object.freeze(Array.from(item, entry => visit(entry, depth + 1)))
    else {
      const source = record(item, 'Decision JSON')
      const entries = Object.entries(Object.getOwnPropertyDescriptors(source)).map(([key, descriptor]) => {
        if (!('value' in descriptor) || !descriptor.enumerable) decisionError('Decision JSON must contain enumerable data properties')
        return [key, visit(descriptor.value, depth + 1)] as const
      })
      if (Object.getOwnPropertySymbols(source).length) decisionError('Decision JSON cannot contain symbol keys')
      copied = Object.freeze(Object.fromEntries(entries))
    }
    seen.delete(item)
    return copied
  }
  const copy = visit(value, 0)
  const bytes = encoder.encode(JSON.stringify(copy)).byteLength
  if (bytes > maxBytes) decisionError('Decision JSON exceeds byte limit')
  if (typeof copy === 'object' && copy !== null) jsonSnapshots.set(copy, { bytes, nodes, depth: maxDepth })
  return copy as T
}
function description(value: unknown, label: string): void {
  if (typeof value === 'string' || Array.isArray(value)) return
  record(value, label)
}
export function snapshotDecisionModelInfo(value: DecisionModelInfo): DecisionModelInfo {
  let info: DecisionModelInfo
  try { info = snapshotJson(value) }
  catch { return decisionError('Decision adapter returned invalid model metadata', true) }
  identifier(info.provider, 'Model provider', true)
  identifier(info.id, 'Model id', true)
  identifier(info.name, 'Model name', true)
  if (info.capabilities !== undefined) {
    const capabilities = record(info.capabilities, 'capabilities', true)
    for (const field of ['maxChoiceOptions', 'maxScoreLevels', 'maxQuestions']) {
      const limit = capabilities[field]
      if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < (field === 'maxQuestions' ? 1 : 2))) decisionError('Invalid decision capability limit', true)
    }
    const types = capabilities.questionTypes
    if (types !== undefined && (!Array.isArray(types) || new Set(types).size !== types.length || types.some(type => !['choice', 'score', 'boolean'].includes(type)))) decisionError('Invalid decision capability question types', true)
  }
  return info
}
function snapshotQuestions<Q extends DecisionQuestions>(value: Q): Q {
  if (questionSnapshots.has(value)) return value
  const questions = record(snapshotJson(value), 'questions')
  const entries = Object.entries(questions)
  if (entries.length === 0 || entries.length > 1_024) decisionError('Invalid decision question count')
  const counts: { type: string; count: number }[] = []
  for (const [id, raw] of entries) {
    identifier(id, 'Question id')
    const question = record(raw, 'question')
    description(question.instructions, 'instructions')
    switch (question.type) {
      case 'choice': {
        const options = Object.entries(record(question.options, 'options'))
        if (options.length < 2 || options.length > 4_096) decisionError('Invalid choice option count')
        counts.push({ type: 'choice', count: options.length })
        for (const [option, detail] of options) {
          identifier(option, 'Option id')
          if (detail !== null) description(detail, 'Option description')
        }
        break
      }
      case 'score':
        if (!Array.isArray(question.levels) || question.levels.length < 2 || question.levels.length > 4_096) decisionError('Invalid score level count')
        counts.push({ type: 'score', count: question.levels.length })
        question.levels.forEach(level => description(level, 'Score level'))
        break
      case 'boolean':
        counts.push({ type: 'boolean', count: 0 })
        if (question.criteria !== undefined) {
          for (const [key, detail] of Object.entries(record(question.criteria, 'criteria'))) {
            if (key !== 'true' && key !== 'false') decisionError('Unknown boolean criterion')
            description(detail, 'Boolean criterion')
          }
        }
        break
      default: decisionError('Unknown decision question type')
    }
  }
  questionSnapshots.set(questions, { size: sizeOf(questions), counts })
  return questions as Q
}
function checkCapabilities(questions: DecisionQuestions, capabilities: DecisionCapabilities): void {
  const { counts } = questionSnapshots.get(questions)!
  if (counts.length > (capabilities.maxQuestions ?? 1_024)) decisionError('Invalid decision question count')
  for (const { type, count } of counts) {
    if (capabilities.questionTypes && !capabilities.questionTypes.includes(type as 'choice')) decisionError('Unsupported decision question type')
    if (type === 'choice' && count > (capabilities.maxChoiceOptions ?? 4_096)) decisionError('Invalid choice option count')
    if (type === 'score' && count > (capabilities.maxScoreLevels ?? 4_096)) decisionError('Invalid score level count')
  }
}
export function snapshotDecisionInput<Q extends DecisionQuestions>(input: DecisionInput<Q>, capabilities: DecisionCapabilities = {}): DecisionInput<Q> {
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647)) decisionError('Invalid decision timeout')
  if (inputSnapshots.has(input)) {
    checkCapabilities(input.questions, capabilities)
    return input
  }
  description(input.state, 'state')
  const questions = snapshotQuestions(input.questions)
  checkCapabilities(questions, capabilities)
  const state = snapshotJson(input.state)
  const stateSize = sizeOf(state), questionSize = questionSnapshots.get(questions)!.size
  // Account for the enclosing {state,questions} object without serializing the same rubric again.
  if (stateSize.nodes + questionSize.nodes + 1 > 100_000 || Math.max(stateSize.depth, questionSize.depth) + 1 > 64) decisionError('Decision JSON exceeds structural limits')
  if (stateSize.bytes + questionSize.bytes + 23 > 2_097_152) decisionError('Decision JSON exceeds byte limit')
  const captured = Object.freeze({ state, questions, ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) })
  inputSnapshots.add(captured)
  return captured
}
/** Internal call fields may change without recopying an already captured JSON payload. */
export function bindDecisionInput<Q extends DecisionQuestions, T extends { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly provider?: string; readonly model?: string; readonly state?: never; readonly questions?: never }>(input: DecisionInput<Q>, fields: T): DecisionInput<Q> & T {
  const captured = Object.freeze({ ...snapshotDecisionInput(input), ...fields }) as DecisionInput<Q> & T
  inputSnapshots.add(captured)
  return captured
}
function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) decisionError('Invalid decision probability', true)
  return value
}
function distribution(value: unknown, keys: readonly string[]): Record<string, number> {
  const source = record(value, 'probabilities', true)
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) decisionError('Probability options do not match question', true)
  const values = keys.map(key => probability(source[key]))
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.001) decisionError('Probabilities must sum to one', true)
  return source as Record<string, number>
}
/** Detached authoritative output; missing evidence stays missing. */
export function validateDecisionResult<Q extends DecisionQuestions>(value: unknown, questions: Q): DecisionResult<Q> {
  if (typeof value === 'object' && value !== null && questionSnapshots.has(questions) && resultSnapshots.get(value) === questions) return value as DecisionResult<Q>
  const result = record(value, 'Decision result', true)
  identifier(result.model, 'Response model', true)
  const answers = record(result.answers, 'answers', true)
  const ids = Object.keys(questions)
  if (Object.keys(answers).length !== ids.length || ids.some(id => !Object.hasOwn(answers, id))) decisionError('Answer ids do not match question ids', true)
  for (const id of ids) {
    const question = questions[id]!
    const answer = record(answers[id], 'answer', true)
    if (answer.type !== question.type) decisionError('Answer type does not match question', true)
    if (answer.confidence !== undefined) probability(answer.confidence)
    if (answer.probabilitySource !== undefined && !['provider', 'token-logprobs', 'model-generated'].includes(answer.probabilitySource as string)) decisionError('Unknown probability provenance', true)
    switch (question.type) {
      case 'choice': {
        if (typeof answer.choice !== 'string' || !Object.hasOwn(question.options, answer.choice)) decisionError('Answer selected an unknown option', true)
        if (answer.probabilities !== undefined) {
          const probabilities = distribution(answer.probabilities, Object.keys(question.options))
          if (probabilities[answer.choice]! + 0.001 < Math.max(...Object.values(probabilities))) decisionError('Choice is not a maximum-probability option', true)
        }
        break
      }
      case 'score': {
        if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.levels.length - 1) decisionError('Score is outside its rubric', true)
        if (answer.probabilities !== undefined) {
          const probabilities = distribution(answer.probabilities, question.levels.map((_, i) => String(i)))
          const expected = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0)
          if (Math.abs(expected - answer.score) > 0.001 * question.levels.length) decisionError('Score does not match its probability distribution', true)
        }
        break
      }
      case 'boolean':
        if (typeof answer.value !== 'boolean') decisionError('Boolean answer must contain a boolean value', true)
        if (answer.probabilityTrue !== undefined) probability(answer.probabilityTrue)
        break
    }
    if ((answer.probabilities !== undefined || answer.probabilityTrue !== undefined || answer.confidence !== undefined) && answer.probabilitySource === undefined) decisionError('Decision evidence requires provenance', true)
  }
  if (result.providerRequestId !== undefined) identifier(result.providerRequestId, 'Request id', true)
  if (result.usage !== undefined) {
    const usage = record(result.usage, 'usage', true)
    for (const counter of Object.values(usage)) {
      if (!Number.isSafeInteger(counter) || (counter as number) < 0) decisionError('Invalid decision usage counter', true)
    }
  }
  try {
    const captured = snapshotJson(result) as unknown as DecisionResult<Q>
    resultSnapshots.set(captured, questions)
    return captured
  }
  catch { return decisionError('Decision response is not bounded JSON', true) }
}
