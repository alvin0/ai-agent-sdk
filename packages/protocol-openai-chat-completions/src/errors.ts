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
 * Narrow on purpose. A false positive would tell the caller their prompt was
 * filtered when in fact their JSON schema was wrong, and the two have opposite
 * fixes. Endpoints in this family are consistent about the token
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
 * Classified as `UNSUPPORTED_CONTENT` rather than as a new `CONTENT_FILTERED`
 * code: the existing code already says exactly this — the request carried
 * content the selected model will not accept — and it is already outside the
 * default retryable set, which is the behaviour a filtered prompt needs.
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
  if (status === 401 || status === 403) return MODEL_ERROR_CODES.AUTH
  if (status === 413) return MODEL_ERROR_CODES.INVALID_REQUEST
  // Ahead of 429: an exhausted quota is usually delivered as 429 but never
  // clears on its own, so retrying it burns latency and money for nothing.
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return MODEL_ERROR_CODES.RATE_LIMIT
  if (status === 400 || status === 422) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    // Only inside the request-rejected statuses: the same wording in a 500 body
    // describes what the endpoint was doing, not why it refused the caller.
    if (isContentFilteredError(detail)) return MODEL_ERROR_CODES.UNSUPPORTED_CONTENT
    return MODEL_ERROR_CODES.INVALID_REQUEST
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
 * A bare-string `error` contributes to the MESSAGE only, never to `detail`.
 * That asymmetry is deliberate: `detail` is what decides the code, and it is
 * held byte-identical to the shared provider mapping so the same
 * `(status, body)` pair cannot classify differently here than it does for an
 * existing provider.
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
  const error = typeof parsed === 'object' && parsed !== null
    && 'error' in (parsed as Record<string, unknown>)
    ? (parsed as Record<string, unknown>).error
    : parsed
  const code = stringField(error, 'code')
  const type = stringField(error, 'type')
  const message = stringField(error, 'message')
  const detailField = stringField(error, 'detail') ?? stringField(parsed, 'detail')
  const parts = [code, type, message ?? detailField]
    .filter((part): part is string => part !== undefined)
  const bareError = typeof error === 'string' && error.length > 0 ? error : undefined
  return {
    message: message ?? detailField ?? bareError,
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
  /** Request URL, included in the fallback message for diagnosis. */
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
  const location = failure.url === undefined ? '' : ` from ${failure.url}`
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
 * inside a `data:` frame. There is no status to classify from, so the wording
 * classifiers carry the whole decision, and the residual case is
 * `MALFORMED_RESPONSE`: an error arriving where content was promised is a
 * broken response, not a server fault to be retried.
 * @param body - the `error` payload of a stream chunk.
 * @param displayName - name used when the payload carries no message.
 * @returns a ModelError with no `status`, since the HTTP call itself succeeded.
 */
export function chatCompletionsStreamError(
  body: WireErrorBody,
  displayName: string,
): ModelError {
  const code = typeof body.code === 'string' ? body.code : undefined
  const detail = [code, body.type, body.message]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
  const classified = isQuotaExceededError(detail)
    ? QUOTA_EXCEEDED_CODE
    : isContextWindowExceededError(detail)
      ? CONTEXT_WINDOW_EXCEEDED_CODE
      : isContentFilteredError(detail)
        ? MODEL_ERROR_CODES.UNSUPPORTED_CONTENT
        : MODEL_ERROR_CODES.MALFORMED_RESPONSE
  return new ModelError(
    body.message ?? `${displayName} inlined an error into the stream`,
    classified,
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
  const code = name === 'TimeoutError'
    ? MODEL_ERROR_CODES.TIMEOUT
    : name === 'AbortError'
      ? MODEL_ERROR_CODES.ABORTED
      : MODEL_ERROR_CODES.TRANSPORT
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : fallbackMessage
  return new ModelError(message, code, { cause: error })
}
