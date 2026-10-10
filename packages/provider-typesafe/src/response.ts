import { ModelError, MODEL_ERROR_CODES, validateUsageCounters, type UsageCounters } from '@alvin0/ai-agent-sdk-core'

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ModelError(
    'TypeSafe returned an invalid response object', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  return value as Record<string, unknown>
}

/** Compare JSON rubric values without depending on object property order. */
export function sameDescription(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') return false
  if (Array.isArray(expected)) return sameArrayDescription(expected, actual)
  if (Array.isArray(actual)) return false
  const keys = Object.keys(expected)
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key) &&
    sameDescription((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]))
}

export function responseUsage(value: unknown): UsageCounters | undefined {
  const raw = object(value).usage
  if (raw === undefined) return undefined
  const source = object(raw)
  const counters = {
    ...(source.input_tokens === undefined ? {} : { inputTokens: source.input_tokens }),
    ...(source.output_tokens === undefined ? {} : { outputTokens: source.output_tokens }),
  }
  const validated = validateUsageCounters(counters)
  if (validated.invalidFields.length || validated.overflow) throw new ModelError(
    'Invalid TypeSafe usage counters', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  return validated.reported
}


function sameArrayDescription(expected: readonly unknown[], actual: unknown): boolean {
  return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => sameDescription(value, actual[index]))
}
