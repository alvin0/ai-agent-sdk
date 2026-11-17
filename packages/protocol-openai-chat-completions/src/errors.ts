/**
 * Wire failures of Chat Completions, mapped onto the SDK's shared error codes.
 *
 * Two constraints shape this module. First, the code set is NOT new: every code
 * produced here already exists in `@alvin0/ai-agent-sdk-core`
 * ({@link MODEL_ERROR_CODES}, {@link QUOTA_EXCEEDED_CODE},
 * {@link CONTEXT_WINDOW_EXCEEDED_CODE}), because a caller routing on `code`
 * must not have to learn a second vocabulary just because the request went to
 * an OpenAI-compatible endpoint instead of a native one (Requirement 10.6).
 * Second, the mapping is a REPRODUCTION of the shared HTTP-to-taxonomy table
 * rather than an import of it: this package's only dependency is core (DD-10),
 * so it cannot reach into `provider-http`. The table is therefore kept
 * deliberately identical — same status ordering, same wording classifiers, same
 * `detail` construction — and a cross-provider property test pins the two
 * together so a future edit to one that is not made to the other fails CI.
 *
 * `retry-after` and the provider request id are read whenever the endpoint
 * sends them, because they are the two facts a retry decision and a support
 * ticket respectively cannot be reconstructed without (Requirement 13.5).
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_ERROR_CODES,
  ModelError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@alvin0/ai-agent-sdk-core'
import type { WireErrorBody } from './wire.ts'

/** Largest slice of an unparseable body kept as classifier input. */
const MAX_DETAIL_LENGTH = 2_048

/**
 * Wording that identifies a moderation rejection rather than a bad request.
 *
 * Narrow on purpose: endpoints in this family are consistent about the token
 * `content_filter` / `content_policy`, so nothing looser is needed.
 */
const CONTENT_FILTER_WORDING = new RegExp(
  String.raw`\bcontent[\s_-]?(?:filter(?:ed|ing)?|policy(?:[\s_-]?violation)?)\b`
  + String.raw`|\bresponsible[\s_-]?ai[\s_-]?policy\b`,
  'i',
)

/**
 * Recognize a moderation rejection in provider error text.
 *
 * A diagnostic aid, not a separate code: a filtered request is
 * `INVALID_REQUEST` everywhere in the SDK — over HTTP, inlined into a stream,
 * and as a `content_filter` finish — so failover and retry treat it the same
 * way whichever path reported it. The member that refused stays healthy.
 * @param detail - provider error code/type/message text joined into one string.
 * @returns true when the wording names content filtering or a content policy.
 */
export function isContentFilteredError(detail: string): boolean {
  return CONTENT_FILTER_WORDING.test(detail)
}

/**
 * Map an HTTP status plus the provider's own error text onto a stable code.
 *
 * The status alone is not enough anywhere interesting: a 429 is either "slow
 * down" (retry) or "your balance is gone" (never retry), and a 400 is either a
 * prompt that overflows the context window (compact and retry), a moderation
 * rejection, or a malformed request. All three distinctions are invisible in
 * the status and each changes what the caller should do next, so the wording
 * classifiers run in a fixed order ahead of the plain status buckets.
 * @param status - status of a non-2xx response.
 * @param detail - provider error code/type/message joined; empty when the body was unusable.
 * @returns the normalized code, or `HTTP_{status}` when nothing classified it.
 */
export function chatCompletionsErrorCode(status: number, detail = ''): string {
  if (authenticationStatus(status)) return MODEL_ERROR_CODES.AUTH
  if (status === 413) return MODEL_ERROR_CODES.INVALID_REQUEST
  // Ahead of 429: an exhausted quota is usually delivered as 429 but never
  // clears on its own, so retrying it burns latency and money for nothing.
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return MODEL_ERROR_CODES.RATE_LIMIT
  if (status === 400 || status === 422) {
    return rejectedRequestCode(detail)
  }
  // A model this endpoint does not serve, or a path this gateway does not
  // mount. Both are the caller's mistake, so neither may land in the retryable
  // SERVER bucket where a 404 would otherwise be retried five times.
  if (status === 404) return MODEL_ERROR_CODES.INVALID_REQUEST
  if (status >= 500) return MODEL_ERROR_CODES.SERVER
  return `HTTP_${status}`
}

/**
 * Parse a `retry-after` header into milliseconds.
 *
 * Both defined forms appear in practice — delta-seconds and an HTTP date — so
 * both are read. A date already in the past yields `undefined` rather than a
 * negative delay, because a negative delay would be rejected downstream and
 * take the whole diagnostic with it.
 * @param value - the raw header value, or `null` when absent.
 * @returns a positive finite delay in milliseconds, or `undefined` when absent or unusable.
 */
export function chatCompletionsRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) {
    const delay = Number(trimmed) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(trimmed) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Header names this endpoint family uses for a request correlation id, in priority order. */
const REQUEST_ID_HEADERS = [
  'request-id',
  'x-request-id',
  'x-requestid',
  'cf-ray',
] as const

/**
 * Extract a provider request id for diagnostics.
 *
 * Nothing programmatic reads it, and it is still worth carrying: when an
 * endpoint misbehaves, this id is the only handle its operators have for
 * finding the request.
 * @param headers - the response headers.
 * @returns the first non-empty id found, or `undefined`.
 */
export function chatCompletionsRequestId(headers: Headers): ProviderRequestId | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)
    if (value !== null && value.length > 0) return ProviderRequestId(value)
  }
  return undefined
}

/** An error body reduced to the two things the mapping needs. */
export interface ParsedChatCompletionsError {
  /** Best human-readable message found, or `undefined` to fall back to the status. */
  readonly message: string | undefined
  /** Provider `code`/`type`/`message` joined, as input to the wording classifiers. */
  readonly detail: string
}

/** Read a string property from an unknown value without trusting its shape. */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reduce an error body to a message and a classifier detail string.
 *
 * Tolerates every shape actually seen on this wire: the canonical
 * `{error: {code, type, message}}`, a bare `{type, message}` with no wrapper, a
 * `{detail: "..."}` in the FastAPI style some compatible endpoints use, an
 * `{error: "..."}` carrying a plain string, and a body that is not JSON at all
 * — which is what a gateway or load balancer sitting in front of the endpoint
 * returns. In the last case the status stays authoritative and the raw text,
 * truncated, is still the best classifier input available.
 *
 * A bare-string `error` contributes to the MESSAGE only, never to `detail`:
 * `detail` is what decides the code. Message and detail are both held
 * identical to the shared provider mapping, so the same `(status, body)` pair
 * cannot read differently here than it does for an existing provider.
 * @param raw - the response body as text.
 * @returns the message and the joined detail.
 */
export function parseChatCompletionsErrorBody(raw: string): ParsedChatCompletionsError {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { message: undefined, detail: raw.slice(0, MAX_DETAIL_LENGTH) }
  }
  const error = errorPayload(parsed)
  const code = stringField(error, 'code')
  const type = stringField(error, 'type')
  const message = stringField(error, 'message')
  const detailField = stringField(error, 'detail') ?? stringField(parsed, 'detail')
  // Some gateways (FPT AI Marketplace, other Kong-style fronts) put a generic
  // `message: "Bad request"` beside the real reason in `description`.
  const description = stringField(error, 'description') ?? stringField(parsed, 'description')
  const parts = [code, type, message ?? detailField, description]
    .filter((part): part is string => part !== undefined)
  const primary = withDescription(message ?? detailField, description)
  const bareError = typeof error === 'string' && error.length > 0 ? error : undefined
  return {
    message: primary ?? bareError,
    detail: parts.join(' '),
  }
}

/** Everything known about a non-2xx Chat Completions response. */
export interface ChatCompletionsHttpFailure {
  /** Status of the response. */
  readonly status: number
  /** The response body as text; empty when it could not be read. */
  readonly body: string
  /** Response headers, read for `retry-after` and the request id. */
  readonly headers: Headers
  /** Name used in the fallback message, e.g. the provider display name. */
  readonly displayName: string
  /** Request URL; its origin is included in the fallback message for diagnosis. */
  readonly url?: string
}

/**
 * Turn a non-2xx response into a fully populated {@link ModelError}.
 *
 * The provider's own message wins when there is one, because it is invariably
 * more specific than anything this layer could synthesize; the synthesized
 * fallback exists for bodies that carry no message at all. `cause` keeps the
 * raw body so a diagnosis is possible even when the classifier found nothing.
 * @param failure - the status, body, and headers of the failed response.
 * @returns a ModelError carrying the code, status, retry delay, and request id.
 */
export function chatCompletionsHttpError(failure: ChatCompletionsHttpFailure): ModelError {
  const { message, detail } = parseChatCompletionsErrorBody(failure.body)
  const delay = chatCompletionsRetryAfterMs(failure.headers.get('retry-after'))
  const id = chatCompletionsRequestId(failure.headers)
  // The origin only, as the shared mapping does: a path or query can carry
  // deployment names or credentials that have no place in an error message.
  const location = failure.url === undefined ? '' : ` from ${originOf(failure.url)}`
  return new ModelError(
    message ?? `${failure.displayName} error (HTTP ${failure.status})${location}`,
    chatCompletionsErrorCode(failure.status, detail),
    {
      cause: new Error(failure.body.length > 0 ? failure.body : `HTTP ${failure.status}`),
      status: failure.status,
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      ...id === undefined ? {} : { requestId: id },
    },
  )
}

/**
 * Map an error the endpoint inlined into a 200 stream onto the same taxonomy.
 *
 * Some gateways answer a rejected request with HTTP 200 and an `error` object
 * (or a plain string) inside a `data:` frame. The fields are read exactly as
 * {@link parseChatCompletionsErrorBody} reads them, so the same payload yields
 * the same message and classifier input on either path. There is no status to
 * classify from, so the wording classifiers decide: an exhausted quota, an
 * overflowing context window, and a content-filter rejection (`INVALID_REQUEST`,
 * as everywhere else) are terminal; anything else is `SERVER`, which IS
 * retryable, because the turn produced nothing usable and a gateway relaying an
 * upstream hiccup mid-stream usually succeeds on retry. With no status to name
 * the failure, the endpoint's `code` (or `type`) is appended to the message.
 * The streaming translator raises exactly this error.
 * @param body - the `error` payload of a stream chunk.
 * @param displayName - name used when the payload carries no message.
 * @returns a ModelError with no `status`, since the HTTP call itself succeeded.
 */
export function chatCompletionsStreamError(
  body: WireErrorBody | string,
  displayName: string,
): ModelError {
  const fields: WireErrorBody = typeof body === 'object' && body !== null ? body : {}
  const message = nonEmptyString(fields.message) ?? nonEmptyString(fields.detail)
  const description = nonEmptyString(fields.description)
  // With no status to fall back on, a plain-string payload is the only wording
  // there is, so it feeds the classifiers too (unlike an HTTP body's bare string).
  const detail = [nonEmptyString(fields.code), nonEmptyString(fields.type), message, description, nonEmptyString(body)]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  const label = typeof fields.code === 'number'
    ? String(fields.code)
    : nonEmptyString(fields.code) ?? nonEmptyString(fields.type)
  const text = withDescription(message, description) ?? nonEmptyString(body)
    ?? `${displayName} reported an error mid-stream`
  return new ModelError(
    label === undefined ? text : `${text} (${label})`,
    inlineFailureCode(detail),
    { cause: new Error(detail.length > 0 ? detail : 'stream error') },
  )
}

/**
 * Classify a failure raised before any status was seen.
 *
 * Kept apart from the status mapping because the three outcomes are decided by
 * WHO ended the request, not by what the endpoint said: the caller's signal
 * (`ABORTED`), a deadline (`TIMEOUT`), or the network (`TRANSPORT`). Web
 * platform semantics supply the distinction — `AbortSignal.timeout` rejects
 * with a `TimeoutError`, an explicit `abort()` with an `AbortError` — so no
 * message parsing is involved.
 * @param error - the thrown value.
 * @param fallbackMessage - message used when the thrown value carries none.
 * @returns a ModelError coded ABORTED, TIMEOUT, or TRANSPORT.
 */
export function chatCompletionsTransportError(
  error: unknown,
  fallbackMessage: string,
): ModelError {
  const name = error instanceof Error ? error.name : ''
  const code = transportFailureCode(name)
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : fallbackMessage
  return new ModelError(message, code, { cause: error })
}

function authenticationStatus(status: number): boolean { return status === 401 || status === 403 }

function rejectedRequestCode(detail: string): string {
  // A content-filter rejection is INVALID_REQUEST like any other refusal; see
  // {@link isContentFilteredError}.
  return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : MODEL_ERROR_CODES.INVALID_REQUEST
}

function errorPayload(parsed: unknown): unknown {
  return typeof parsed === 'object' && parsed !== null
    && 'error' in (parsed as Record<string, unknown>)
    ? (parsed as Record<string, unknown>).error
    : parsed

}

function inlineFailureCode(detail: string): string {
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  // Same code as a `content_filter` finish and a filtered HTTP 400: terminal.
  if (isContentFilteredError(detail)) return MODEL_ERROR_CODES.INVALID_REQUEST
  return MODEL_ERROR_CODES.SERVER
}

function transportFailureCode(name: string): string {
  if (name === 'TimeoutError') return MODEL_ERROR_CODES.TIMEOUT
  if (name === 'AbortError') return MODEL_ERROR_CODES.ABORTED
  return MODEL_ERROR_CODES.TRANSPORT
}

/** Join a generic message and a more specific description, without repeating either. */
function withDescription(message: string | undefined, description: string | undefined): string | undefined {
  if (description === undefined || message === description) return message ?? description
  if (message === undefined) return description
  return `${message}: ${description}`
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function originOf(url: string): string {
  try { return new URL(url).origin } catch { return 'the endpoint' }
}
