import { ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { abortable, throwIfAborted } from './async.ts'

export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
})

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

export async function readDecisionJson(
  response: Response, maxBytes: number, signal: AbortSignal, label: string,
): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (length > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new ModelError(`${label} response exceeds byte limit`, MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  }
  if (!response.body) throw new ModelError(`${label} returned an empty response`, MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maxBytes) throw new ModelError(`${label} response exceeds byte limit`,
        MODEL_ERROR_CODES.MALFORMED_RESPONSE)
      text += decoder.decode(item.value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as unknown }
    catch { throw new ModelError(`${label} returned invalid JSON`, MODEL_ERROR_CODES.MALFORMED_RESPONSE) }
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof ModelError) throw error
    throw new ModelError(`${label} returned an unreadable JSON response`, MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  } finally {
    // Do not wait indefinitely for a foreign stream's cancellation hook.
    void reader.cancel().catch(() => {})
  }
}
