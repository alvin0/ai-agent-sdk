import { ModelError, MODEL_ERROR_CODES, validateUsageCounters, type UsageCounters } from '@alvin0/ai-agent-sdk-core'

export function malformed(message: string): never {
  throw new ModelError(`OpenAI Decisions ${message}`, MODEL_ERROR_CODES.MALFORMED_RESPONSE)
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed(
    'returned an invalid object')
  return value as Record<string, unknown>
}
export function responseUsage(value: unknown): UsageCounters | undefined {
  const raw = object(value).usage
  if (raw === undefined) return undefined
  const source = object(raw)
  const details = source.input_tokens_details === undefined ? {} : object(source.input_tokens_details)
  const output = source.output_tokens_details === undefined ? {} : object(source.output_tokens_details)
  const cached = details.cached_tokens
  const written = details.cache_write_tokens
  const counters = {
    ...field('inputTokens', uncachedInput(source.input_tokens, cached, written)),
    ...field('outputTokens', source.output_tokens), ...field('totalTokens', source.total_tokens),
    ...field('cacheReadTokens', cached), ...field('cacheWriteTokens', written),
    ...field('reasoningTokens', output.reasoning_tokens),
  }
  const validated = validateUsageCounters(counters)
  if (validated.invalidFields.length || validated.overflow) return malformed('returned invalid usage counters')
  return validated.reported
}
function field(name: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [name]: value }
}
function uncachedInput(input: unknown, cached: unknown, written: unknown): unknown {
  if (input === undefined) return undefined
  if (typeof input !== 'number') return input
  const cacheRead = cached === undefined ? 0 : cached
  const cacheWrite = written === undefined ? 0 : written
  if (typeof cacheRead !== 'number' || typeof cacheWrite !== 'number') return malformed(
    'returned invalid cache counters')
  return input - cacheRead - cacheWrite
}
