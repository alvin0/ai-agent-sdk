import { ModelError, MODEL_ERROR_CODES, validateUsageCounters, type UsageCounters } from '@alvin0/ai-agent-sdk-core'
import { abortable, throwIfAborted } from '@alvin0/ai-agent-sdk-decision-adapter/transport'

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

export function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

export function statusCode(status: number): string {
  if (status === 401 || status === 403) return MODEL_ERROR_CODES.AUTH
  if (status === 429) return MODEL_ERROR_CODES.RATE_LIMIT
  if (status >= 500) return MODEL_ERROR_CODES.SERVER
  return MODEL_ERROR_CODES.INVALID_REQUEST
}

export async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (length > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new ModelError('TypeSafe response exceeds byte limit', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  }
  if (!response.body) throw new ModelError('TypeSafe returned an empty response', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maxBytes) throw new ModelError('TypeSafe response exceeds byte limit',
        MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      text += decoder.decode(item.value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as unknown }
    catch { throw new ModelError('TypeSafe returned invalid JSON', MODEL_ERROR_CODES.MALFORMED_RESPONSE) }
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof ModelError) throw error
    throw new ModelError('TypeSafe returned an unreadable JSON response', MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  } finally {
    // Do not wait indefinitely for a foreign stream's cancellation hook.
    void reader.cancel().catch(() => {})
  }
}

function sameArrayDescription(expected: readonly unknown[], actual: unknown): boolean {
  return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => sameDescription(value, actual[index]))
}
