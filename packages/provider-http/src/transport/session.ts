/**
 * The one risky chain every HTTP pipeline in this package runs, written once.
 *
 * Everything here is a step that is invisible when it works and expensive when it
 * is missing: fusing the caller's cancellation with our own teardown controller and
 * the request deadline, bounding the outbound body, letting a diagnostic observer
 * look at the request without letting it veto dispatch, opening a provider attempt
 * before the socket and closing it exactly once afterwards, refusing a redirect
 * instead of replaying credentials to wherever it points, turning a non-2xx into a
 * stable code with `retry-after` and a request id attached, and releasing the
 * response body when the consumer walks away early.
 *
 * A second copy of this chain for embedding would be a second chance to forget one
 * of those steps — which is precisely why the chain, and not the decoding, is what
 * gets shared. What a pipeline supplies is only `decode`: what to do with a
 * response that already passed every guard above.
 *
 * The classification order at the bottom is part of the contract and is deliberately
 * not simplified: a fired deadline outranks an abort the caller did not request,
 * an aborted fused signal outranks a transport failure, and an admission refusal
 * from `startProviderAttempt` is rethrown untouched so audit mode's decision is not
 * relabelled as a transport error.
 *
 * @module ai-agent-sdk/providers/transport/session
 */

import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type {
  ModelFailure,
  ModelInvocationContext,
  ProviderAttemptHandle,
  ProviderRequestId,
  SafeErrorRecord,
  UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import { normalizeHttpBoundaryError } from '../common/failure.ts'
import type { HttpTransportConnection } from './connection.ts'
import {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
} from './errors.ts'
import {
  abortError,
  cancelResponseBody,
  endpointUrl,
  raceWithSignal,
  readBoundedText,
  redactHeaders,
  rejectProviderRedirect,
  requestLogId,
  safeProviderFailure,
} from './http.ts'
import { resolveTransportLimits, type ResolvedTransportLimits } from './limits.ts'

/** One serialized request body, measured before anything is sent. */
export interface PreparedWireBody {
  /** The value handed to the diagnostic observer; never re-serialized. */
  readonly value: unknown
  /** Exact bytes sent on the wire. */
  readonly encoded: string
  /** UTF-8 length of {@link encoded}. */
  readonly bytes: number
}

/**
 * How the transport obtains the body.
 *
 * A thunk exists because the pipeline that owns serialization also owns caching it
 * across repeated `stream()` calls on one prepared call, and because building the
 * body may itself do work that must observe the fused signal — which does not exist
 * until the transport creates it.
 */
export type WireBodySource =
  | PreparedWireBody
  | ((signal: AbortSignal) => PreparedWireBody | Promise<PreparedWireBody>)

/**
 * One exact wire request, observed immediately before dispatch.
 *
 * Structurally identical to the generation pipeline's record, and deliberately
 * declared here so the transport does not depend on a pipeline for its own shape.
 */
export interface WireRequestRecord {
  readonly schemaVersion: 1
  readonly type: 'provider-request'
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly method: 'POST'
  readonly url: string
  /** Credentials and cookies already replaced by `[REDACTED]`. */
  readonly headers: Readonly<Record<string, string>>
  /** The exact serialized value. This may contain prompts and tool output. */
  readonly body: unknown
  readonly bodyBytes: number
}

/** Everything the shared chain needs to issue ONE request. */
export interface HttpTransportRequestInput {
  /** The snapshot this request is bound to; read once, never re-read mid-request. */
  readonly connection: HttpTransportConnection
  /** Provider display name used in every message this chain raises. */
  readonly displayName: string
  /** Route being served. */
  readonly provider: string
  /** Wire model id. */
  readonly model: string
  /** Path appended to {@link HttpTransportConnection.baseUrl}. */
  readonly path: string
  /**
   * Media type this pipeline requires back.
   *
   * The transport does not enforce it — the `accept` header travels on the
   * connection snapshot and the check belongs to whoever decodes — but it is carried
   * on the session so `decode` states its expectation in one place.
   */
  readonly accept: string
  readonly body: WireBodySource
  /** The caller's cancellation, fused with the deadline and our teardown. */
  readonly signal?: AbortSignal
  readonly context?: ModelInvocationContext
  /** Override status-to-code mapping for a provider with codes of its own. */
  readonly errorCode?: (status: number, detail: string) => string
  /** Best-effort diagnostic observer; never a dispatch veto. */
  readonly observeRequest?: (record: WireRequestRecord) => Promise<void> | void
}

/** Outcome vocabulary a pipeline may report for the attempt ledger. */
export type TransportAttemptStatus = 'success' | 'error' | 'aborted' | 'unknown'

/** A response that already cleared every transport guard, plus its ledger hooks. */
export interface HttpTransportSession {
  /** The response; its body is still unread and is owned by the transport. */
  readonly response: Response
  readonly url: string
  readonly origin: string
  /** Fused signal: caller + request deadline + transport teardown. */
  readonly signal: AbortSignal
  /** Provider correlation id, when the response carried one. */
  readonly providerRequestId?: ProviderRequestId
  /** Media type the pipeline asked for; see {@link HttpTransportRequestInput.accept}. */
  readonly accept: string
  readonly limits: ResolvedTransportLimits
  /**
   * Record a usage report as attempt evidence.
   *
   * Evidence only: whether a report is complete enough to leave the SDK as
   * `TokenUsage` is a pipeline decision, and this hook does not make it.
   */
  readonly attemptId?: string
  reportUsage(usage: UsageCounters, final?: boolean): void
  /** Record the terminal outcome the decoded stream reported. */
  reportOutcome(status: TransportAttemptStatus, failure?: ModelFailure): void
}

/**
 * Run one request through the shared safety chain and stream `use`'s output.
 *
 * The generator shape matters: the provider attempt stays open, and the response
 * body stays owned, for as long as the consumer keeps pulling. A consumer that
 * stops early aborts the teardown controller in `finally`, which is what tears down
 * an in-flight response instead of leaking the connection.
 * @param input - the request facts, all captured from one connection snapshot.
 * @param use - decodes a guarded response; its failures are classified here.
 * @returns whatever `use` yields, unchanged.
 */
export async function* withTransportSession<T>(
  input: HttpTransportRequestInput,
  use: (session: HttpTransportSession) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const { connection, context, displayName, model, provider } = input
  const callerSignal = input.signal
  // One controller for our own teardown, fused with the caller's. Aborting ours
  // in `finally` is what tears down an in-flight response when the consumer
  // stops reading early, instead of leaking the connection.
  const consumer = new AbortController()
  const limits = resolveTransportLimits(connection)
  const timeout = AbortSignal.timeout(limits.requestTimeoutMs)
  const signal = AbortSignal.any([
    consumer.signal,
    timeout,
    ...callerSignal === undefined ? [] : [callerSignal],
  ])

  let admissionFailure: { readonly value: unknown } | undefined
  let ownedResponse: Response | undefined
  try {
    signal.throwIfAborted()
    const preparedBody = typeof input.body === 'function'
      ? await input.body(signal)
      : input.body
    if (preparedBody.bytes > limits.maxRequestBytes) {
      throw new ModelError(
        `${displayName} request exceeds the ${limits.maxRequestBytes}-byte limit`,
        MODEL_ERROR_CODES.INVALID_REQUEST,
      )
    }
    const endpoint = endpointUrl(
      connection.baseUrl,
      input.path,
      connection.allowInsecureHttp ?? false,
    )
    const url = endpoint.href
    const origin = endpoint.origin
    const headers = connection.headers

    // Logging is deliberately best-effort. A full disk or broken debug sink
    // must not turn a valid provider request into an application outage.
    try {
      const loggerSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(limits.requestLoggerTimeoutMs),
      ])
      await raceWithSignal(Promise.resolve(input.observeRequest?.({
        schemaVersion: 1,
        type: 'provider-request',
        id: requestLogId(),
        timestamp: new Date().toISOString(),
        provider,
        model,
        method: 'POST',
        url,
        headers: redactHeaders(headers, connection.sensitiveHeaderNames),
        body: preparedBody.value,
        bodyBytes: preparedBody.bytes,
      })), loggerSignal)
    } catch {
      // Contained by contract; see `observeRequest` above.
    }

    let attempt: ProviderAttemptHandle | undefined
    let dispatchState: 'not-sent' | 'sent' | 'unknown' = 'not-sent'
    let httpStatus: number | undefined
    let providerRequestId: ProviderRequestId | undefined
    let attemptStatus: TransportAttemptStatus = 'unknown'
    let attemptUsage: UsageCounters | undefined
    let usageFinal = true
    let attemptError: SafeErrorRecord | undefined
    try {
      signal.throwIfAborted()
      try {
        attempt = await context?.startProviderAttempt?.({
          provider,
          model,
          method: 'POST',
          origin,
        }, signal)
      } catch (error: unknown) {
        // Audit mode refused this dispatch. That decision travels out verbatim.
        admissionFailure = { value: error }
        throw error
      }
      signal.throwIfAborted()
      dispatchState = 'unknown'
      const fetchImplementation = connection.fetch ?? globalThis.fetch
      const pendingResponse = fetchImplementation(url, {
        method: 'POST',
        headers,
        body: preparedBody.encoded,
        signal,
        redirect: 'manual',
      })
      // Retain cleanup ownership even if an injected fetch ignores abort.
      void pendingResponse.then(response => {
        if (signal.aborted) return cancelResponseBody(response)
        return undefined
      }, () => undefined)
      const response = await raceWithSignal(pendingResponse, signal)
      ownedResponse = response
      signal.throwIfAborted()
      dispatchState = 'sent'
      httpStatus = response.status
      providerRequestId = requestIdFrom(response.headers)
      await rejectProviderRedirect(response, url)

      if (!response.ok) {
        throw await httpFailure(response, origin, limits.maxErrorBodyBytes, signal, input)
      }

      const session: HttpTransportSession = Object.freeze({
        response,
        url,
        origin,
        signal,
        accept: input.accept,
        limits,
        ...providerRequestId === undefined ? {} : { providerRequestId },
        reportUsage(usage: UsageCounters, final = true) {
          attemptUsage = usage
          usageFinal = final
        },
        ...(attempt === undefined ? {} : { attemptId: attempt.attemptId }),
        reportOutcome(status: TransportAttemptStatus, failure?: ModelFailure) {
          attemptStatus = status
          if (failure !== undefined) attemptError = safeProviderFailure(failure)
        },
      })
      yield* use(session)
    } catch (error: unknown) {
      if (admissionFailure !== undefined && error === admissionFailure.value) throw error
      const mapped = timeout.aborted && callerSignal?.aborted !== true
        ? new ModelError(
          `${displayName} request exceeded its ${limits.requestTimeoutMs}ms time limit`,
          MODEL_ERROR_CODES.TIMEOUT,
          { cause: error },
        )
        : signal.aborted
          ? abortError(displayName, error)
          : normalizeHttpBoundaryError(
            error,
            `${displayName} request to ${origin} failed`,
          )
      attemptStatus = mapped.code === MODEL_ERROR_CODES.ABORTED ? 'aborted' : 'error'
      attemptError = safeProviderFailure(mapped.failure)
      throw mapped
    } finally {
      attempt?.end({
        status: attemptStatus,
        dispatchState,
        ...attemptUsage === undefined ? {} : { reported: attemptUsage },
        ...usageFinal ? {} : { usageFinal: false },
        ...httpStatus === undefined ? {} : { httpStatus },
        ...providerRequestId === undefined ? {} : { providerRequestId },
        ...attemptError === undefined ? {} : { error: attemptError },
      })
    }
  } catch (error: unknown) {
    if (callerSignal?.aborted === true) throw abortError(displayName, error)
    if (timeout.aborted) {
      throw new ModelError(
        `${displayName} request exceeded its ${limits.requestTimeoutMs}ms time limit`,
        MODEL_ERROR_CODES.TIMEOUT,
        { cause: error },
      )
    }
    if (admissionFailure !== undefined && error === admissionFailure.value) throw error
    throw normalizeHttpBoundaryError(error, `${displayName} stream failed`)
  } finally {
    consumer.abort(new Error(`${displayName} stream consumer stopped`))
    if (ownedResponse !== undefined) await cancelResponseBody(ownedResponse)
  }
}

/**
 * Turn a non-2xx response into a fully populated {@link ModelError}.
 *
 * The body is read under the same bound and the same signal as everything else,
 * and a body that cannot be read does not replace the status — the status is the
 * more reliable signal of the two anyway.
 * @param response - the non-success response.
 * @param origin - request origin, reported in the message instead of the full URL.
 * @param maxBytes - error-body bound from the resolved limits.
 * @param signal - the fused signal.
 * @param input - request facts, for the display name and code override.
 * @returns the mapped error, carrying status, `retry-after`, and request id.
 */
async function httpFailure(
  response: Response,
  origin: string,
  maxBytes: number,
  signal: AbortSignal,
  input: HttpTransportRequestInput,
): Promise<ModelError> {
  let raw = ''
  try {
    raw = await readBoundedText(response, maxBytes, signal)
  } catch {
    // A truncated error body must not replace the status, which is the more
    // reliable signal anyway.
  }
  const { message, detail } = parseErrorBody(raw)
  const delay = retryAfterMs(response.headers.get('retry-after'))
  const id = requestIdFrom(response.headers)
  return new ModelError(
    message ?? `${input.displayName} error (HTTP ${response.status}) from ${origin}`,
    (input.errorCode ?? httpErrorCode)(response.status, detail),
    {
      cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
      status: response.status,
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      ...id === undefined ? {} : { requestId: id },
    },
  )
}
