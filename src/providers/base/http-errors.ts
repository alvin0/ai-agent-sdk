/**
 * The HTTP-to-taxonomy mapping every provider shares.
 *
 * Kept here rather than per provider because the interesting decisions are
 * genuinely vendor-independent: a 429 that means "slow down" versus one that
 * means "your balance is gone", and a 400 that means "your prompt is too long"
 * versus one that means "your schema is wrong". Both distinctions are invisible
 * in the status code and both change what the caller should do, so getting them
 * right once is worth more than getting them right three times.
 *
 * @module ai-agent-sdk/providers/base/http-errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@ai-agent-sdk/core'
import { MODEL_ERROR_CODES } from '@ai-agent-sdk/core'
import { ProviderRequestId } from '@ai-agent-sdk/core'

/**
 * Map an HTTP status plus whatever the provider said into a stable code.
 *
 * `detail` should be the provider's error `code`, `type`, and `message` joined
 * into one string — the wording classifiers need all three because providers
 * disagree about which field carries the useful part.
 * @param status - status of a non-2xx response.
 * @param detail - provider error text, joined; empty string when the body was unparseable.
 * @returns the normalized code.
 */
export function httpErrorCode(status: number, detail = ''): string {
  if (status === 401 || status === 403) return MODEL_ERROR_CODES.AUTH
  if (status === 413) return MODEL_ERROR_CODES.INVALID_REQUEST
  // Checked BEFORE 429: an exhausted quota is often delivered as 429 but never
  // clears on its own, so retrying it burns latency and money for nothing.
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return MODEL_ERROR_CODES.RATE_LIMIT
  if (status === 400 || status === 422) {
    return isContextWindowExceededError(detail)
      ? CONTEXT_WINDOW_EXCEEDED_CODE
      : MODEL_ERROR_CODES.INVALID_REQUEST
  }
  // A missing model or route is the caller's mistake, not a server fault, so it
  // must not land in the retryable SERVER bucket.
  if (status === 404) return MODEL_ERROR_CODES.INVALID_REQUEST
  if (status >= 500) return MODEL_ERROR_CODES.SERVER
  return `HTTP_${status}`
}

/**
 * Parse a `retry-after` header into milliseconds.
 *
 * The header comes in two forms — delta-seconds and an HTTP date — and both are
 * used in practice. A date already in the past yields `undefined` rather than a
 * negative delay.
 * @param value - the raw header value, or `null` when absent.
 * @returns a positive finite delay, or `undefined` when absent or unusable.
 */
export function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const delay = Number(trimmed) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(trimmed) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Header names providers use for their request correlation id, in priority order. */
const REQUEST_ID_HEADERS = [
  'request-id',
  'x-request-id',
  'x-requestid',
  'cf-ray',
] as const

/**
 * Extract a provider request id for diagnostics.
 *
 * Worth capturing even though nothing programmatic reads it: when a provider is
 * misbehaving, this id is what their support needs to find the request.
 * @param headers - the response headers.
 * @returns the first non-empty id found, or `undefined`.
 */
export function requestIdFrom(headers: Headers): ProviderRequestId | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)
    if (value !== null && value.length > 0) return ProviderRequestId(value)
  }
  return undefined
}

/** A provider error body reduced to the two things this SDK needs. */
export interface ParsedErrorBody {
  /** Best human-readable message found, or `undefined` to fall back to the status. */
  message: string | undefined
  /** Provider `code`/`type`/`message` joined, for the wording classifiers. */
  detail: string
}

/** Read a string property from an unknown object without trusting its shape. */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reduce a provider error body to a message and a classifier detail string.
 *
 * Handles the two shapes both providers use — `{error: {...}}` and a bare
 * `{type, message}` — and tolerates a body that is not JSON at all, which is what
 * a gateway or load balancer in front of the provider will return.
 * @param raw - the response body as text.
 * @returns the message and joined detail.
 */
export function parseErrorBody(raw: string): ParsedErrorBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // An HTML error page from an intermediary. The status stays authoritative,
    // and the raw text is still the best classifier input available.
    return { message: undefined, detail: raw.slice(0, 2_048) }
  }
  const error = typeof parsed === 'object' && parsed !== null
    && 'error' in (parsed as Record<string, unknown>)
    ? (parsed as Record<string, unknown>).error
    : parsed
  const code = stringField(error, 'code')
  const type = stringField(error, 'type')
  const message = stringField(error, 'message')
  // The ChatGPT-backed Codex endpoint reports some rejections as a bare
  // `{"detail": "..."}` — a FastAPI convention — with no `error` wrapper and no
  // `message`. Without this, a perfectly clear "that model is not supported"
  // would surface as an opaque "HTTP 400".
  const detailField = stringField(error, 'detail') ?? stringField(parsed, 'detail')
  const parts = [code, type, message ?? detailField]
    .filter((part): part is string => part !== undefined)
  return {
    message: message ?? detailField,
    detail: parts.join(' '),
  }
}
