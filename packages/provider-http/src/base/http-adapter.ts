/**
 * The single HTTP/SSE pipeline every provider in this package runs through.
 *
 * This is a template method, and that is the point. `stream()` is implemented
 * HERE and is not an extension point: a provider cannot accidentally ship its own
 * fetch loop that forgets attribution headers, mishandles abort, leaks a response
 * body, or invents its own error codes. What a provider supplies is only the four
 * things that are genuinely vendor-specific:
 *
 * - {@link HttpModelAdapter.connect} — where to send it and with what credentials
 * - {@link HttpModelAdapter.endpointPath} — the path under the base URL
 * - {@link HttpModelAdapter.buildBody} — normalized request to wire JSON
 * - {@link HttpModelAdapter.translate} — wire SSE events to `StreamChunk`s
 *
 * Everything else — connection snapshotting, the catalog, modality checks, the
 * request, HTTP error mapping, `retry-after`, request ids, SSE decoding, the idle
 * bound, and teardown — is shared and happens exactly once, here.
 *
 * @module ai-agent-sdk/providers/base/http-adapter
 */

import { ModelAdapter, type PreparedAdapterCall } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type {
  ModelInfo,
  ModelModality,
  ModelReasoningInfo,
  ProviderInfo,
  ResolvedModelInfo,
} from '@alvin0/ai-agent-sdk-core'
import type { ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { NativeToolName } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import { contentHasImage } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type {
  ProviderAttemptHandle,
  SafeErrorRecord,
  TokenUsage,
  UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import { validateUsageCounters } from '@alvin0/ai-agent-sdk-core'
import { parseSseBounded } from '../stream/parser.ts'
import type { SseEvent } from '../stream/sse.ts'
import { DEFAULT_MAX_SSE_EVENT_CHARS, DEFAULT_MAX_SSE_EVENTS } from '../stream/config.ts'
import { createStreamIdleDeadline } from '../stream/idle-deadline.ts'
import { requireTerminalFinish } from '../stream/terminal.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import { normalizeHttpBoundaryError } from '../common/failure.ts'
import { mergeHeaderLayers } from '../common/header-layers.ts'
import { attributionHeaders } from '@alvin0/ai-agent-sdk-core'
import { httpErrorCode, parseErrorBody, requestIdFrom, retryAfterMs } from './http-errors.ts'
import {
  abortError,
  boundedResponseBody,
  cancelResponseBody,
  catalogModelInfo,
  endpointUrl,
  positiveFinite,
  positiveInteger,
  raceWithSignal,
  readBoundedText,
  redactHeaders,
  rejectProviderRedirect,
  resolvedCatalogModelInfo,
  requestLogId,
  safeProviderFailure,
  withAbortSignal,
} from './transport.ts'

export { redactHeaders } from './transport.ts'

/** Default idle bound: five minutes without a single byte is a hung stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default end-to-end bound once provider request construction begins. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
/** Default serialized request ceiling. */
export const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
/** Default cumulative successful response-body ceiling. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** Default number of raw response chunks accepted from one request. */
export const DEFAULT_MAX_RESPONSE_CHUNKS = 100_000
/** Default error body retained for classification and diagnostics. */
export const DEFAULT_MAX_ERROR_BODY_BYTES = 1024 * 1024
/** Default diagnostic observer deadline; logging must never gate dispatch indefinitely. */
export const DEFAULT_REQUEST_LOGGER_TIMEOUT_MS = 5_000

/** One model a provider's configuration advertises. */
export interface ProviderCatalogModel {
  /** Wire model id, passed to the provider verbatim. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional detail distinguishing similar variants. */
  description?: string
  /** Combined request/response capacity, when known. */
  contextWindow?: number
  /** Per-request output cap for this model. */
  maxTokens?: number
  /** Accepted request modalities; omission is treated as text-only. */
  inputModalities?: readonly ModelModality[]
  /** Modalities this model route may return. */
  outputModalities?: readonly ModelModality[]
  /** Provider-native tools explicitly supported; omission means unknown. */
  nativeTools?: readonly NativeToolName[]
  /** Reasoning levels this model offers, when any. */
  reasoning?: ModelReasoningInfo
}

/**
 * Everything needed to issue ONE request, captured as a single snapshot.
 *
 * The snapshot exists to close a specific gap: if the endpoint and the credential
 * were read separately, a configuration change between the two reads would send
 * one generation's secret to another generation's URL. Reading them together, once
 * per call, makes that impossible.
 */
export interface HttpConnection {
  /** Endpoint base; the provider's {@link HttpModelAdapter.endpointPath} is appended. */
  readonly baseUrl: string
  /**
   * Every header for the request, INCLUDING authorization.
   *
   * Resolved in `connect()` so the credential travels with the endpoint it will
   * be sent to. The base pipeline adds attribution and `accept` on top.
   */
  readonly headers: Readonly<Record<string, string>>
  /** Auth-produced names that must be redacted regardless of spelling. */
  readonly sensitiveHeaderNames?: readonly string[]
  /** Maximum idle interval while a read is outstanding. */
  readonly streamIdleTimeoutMs: number
  /** End-to-end request/stream timeout. */
  readonly requestTimeoutMs?: number
  /** Maximum serialized outbound request bytes. */
  readonly maxRequestBytes?: number
  /** Maximum cumulative successful response bytes. */
  readonly maxResponseBytes?: number
  /** Maximum raw chunks accepted from a successful response. */
  readonly maxResponseChunks?: number
  /** Maximum decoded SSE events accepted from one response. */
  readonly maxSseEvents?: number
  /** Maximum characters accepted in one decoded SSE event. */
  readonly maxSseEventChars?: number
  /** Maximum bytes read from a non-success response. */
  readonly maxErrorBodyBytes?: number
  /** Maximum time granted to the optional request logger. */
  readonly requestLoggerTimeoutMs?: number
  /** Permit cleartext HTTP explicitly, for trusted local development endpoints only. */
  readonly allowInsecureHttp?: boolean
  /** Captured fetch implementation; omission uses the platform global. */
  readonly fetch?: typeof globalThis.fetch
  /** Retry policy this route owns. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Advisory catalog; requests are never restricted to it. */
  readonly models: readonly ProviderCatalogModel[]
  /** Output cap applied when neither the caller nor the model entry names one. */
  readonly defaultMaxTokens: number
  /** Context capacity used when the selected model has no exact value. */
  readonly defaultContextWindow: number
}

/** What {@link HttpModelAdapter.buildBody} and `translate` receive. */
export interface ProviderRequest {
  /** The normalized request, with registry-resolved defaults already applied. */
  readonly options: GenerateOptions
  /** Exact model metadata for this call. */
  readonly model: ResolvedModelInfo
  /** The connection snapshot this call is bound to. */
  readonly connection: HttpConnection
  /** Output cap to send; always resolved to a number, which some APIs require. */
  readonly maxTokens: number
}

/**
 * One exact wire request observed immediately before the shared pipeline calls `fetch`.
 * @deprecated High-risk compatibility diagnostics; prefer structured observation.
 */
export interface ProviderRequestLogRecord {
  /** Version of this durable/debug record shape. */
  readonly schemaVersion: 1
  readonly type: 'provider-request'
  /** Locally generated correlation id; providers may assign a different id later. */
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly method: 'POST'
  readonly url: string
  /** Request headers with credentials and cookies replaced by `[REDACTED]`. */
  readonly headers: Readonly<Record<string, string>>
  /** Exact protocol-serialized JSON body. This may contain prompts and tool output. */
  readonly body: unknown
  readonly bodyBytes: number
}

/**
 * Optional observer for exact provider-wire requests.
 * @deprecated High-risk compatibility diagnostics; prefer structured observation.
 */
export type ProviderRequestLogger = (
  record: ProviderRequestLogRecord,
) => Promise<void> | void

interface PreparedWireBody {
  readonly value: unknown
  readonly encoded: string
  readonly bytes: number
}

interface PreparedWireBodyCache {
  prepared?: Promise<PreparedWireBody>
}

/** Base for every HTTP provider adapter in this package. */
export abstract class HttpModelAdapter extends ModelAdapter {
  /** Human-readable provider name reported by {@link providerInfo}. */
  protected abstract readonly displayName: string

  /**
   * Capture the connection facts for one operation.
   *
   * Called once per operation and never re-read mid-request. Resolve the
   * credential here, together with the endpoint.
   * @param provider - the route being served.
   * @param signal - cancellation for any I/O this resolution performs.
   */
  protected abstract connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<HttpConnection>

  /** Path appended to {@link HttpConnection.baseUrl}, e.g. `/v1/messages`. */
  protected abstract endpointPath(request: ProviderRequest): string

  /** Convert the normalized request into this provider's wire JSON. */
  protected abstract buildBody(request: ProviderRequest): Promise<unknown> | unknown

  /**
   * Convert this provider's SSE events into the SDK's chunk protocol.
   *
   * Owns termination: this generator decides what ends the stream (a `[DONE]`
   * sentinel, a named terminal event, or end of body) and must raise
   * `STREAM_CLOSED` when the body ends before the provider said it was finished.
   */
  protected abstract translate(
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderProtocolChunk>

  /**
   * Extra headers merged in by the base pipeline. Override to change `accept`.
   * @returns headers applied beneath {@link HttpConnection.headers}.
   */
  protected baseHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
    }
  }

  /**
   * Observe an exact, credential-redacted wire request before dispatch.
   *
   * The default is a no-op so library users do not silently persist prompts.
   * Implementations should treat this as diagnostics, not a dispatch veto.
   * @deprecated High-risk compatibility diagnostics; prefer structured observation.
   */
  protected observeRequest(_record: ProviderRequestLogRecord): Promise<void> | void {}

  /**
   * Map a non-2xx response to a stable code. Override only to add codes this
   * provider reports that the shared mapping cannot infer from the status.
   */
  protected providerErrorCode(status: number, detail: string): string {
    return httpErrorCode(status, detail)
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: this.displayName }
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    const connection = this.captureConnection(await this.connect(provider, signal))
    return connection.models.map(model => catalogModelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    const connection = this.captureConnection(await this.connect(provider, signal))
    return this.decorateModel(this.modelInfoFor(connection, provider, model), connection)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    context?.declareProviderAttemptAccounting?.()
    // Snapshot once, then bind both the capability answer and the eventual
    // dispatch to it, so the two cannot come from different generations.
    const connection = this.captureConnection(await this.connect(provider, signal, context))
    const info = this.decorateModel(this.modelInfoFor(connection, provider, model), connection)
    const wireBody: PreparedWireBodyCache = {}
    return {
      model: info,
      stream: (options, invocation = context) => this.run(
        options,
        connection,
        info,
        invocation,
        wireBody,
      ),
    }
  }

  /**
   * Stream one model call.
   *
   * Intentionally NOT an extension point — see the module note. Providers
   * customize behaviour through the abstract members instead.
   */
  stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.runResolving(options, context)
  }

  /** Resolve a connection first, for the un-prepared entry point. */
  private async * runResolving(options: GenerateOptions, context?: ModelInvocationContext): AsyncGenerator<StreamChunk> {
    context?.declareProviderAttemptAccounting?.()
    const connection = this.captureConnection(
      await this.connect(options.provider, options.signal, context),
    )
    const info = this.decorateModel(
      this.modelInfoFor(connection, options.provider, options.model),
      connection,
    )
    yield* this.run(options, connection, info, context, {})
  }

  /** Resolve exact-model metadata from the catalog, falling back to config defaults. */
  protected modelInfoFor(
    connection: HttpConnection,
    provider: string,
    model: string,
  ): ResolvedModelInfo {
    return resolvedCatalogModelInfo(
      provider, model, connection.models,
      connection.defaultMaxTokens, connection.defaultContextWindow,
    )
  }

  /** Decorate resolved metadata without reopening the captured connection generation. */
  protected decorateModel(
    info: ResolvedModelInfo,
    _connection: HttpConnection,
  ): ResolvedModelInfo {
    return info
  }

  /** Capture legacy subclass transport/auth layers once; configured adapters already return all five. */
  private captureConnection(connection: HttpConnection): HttpConnection {
    const transport = this.baseHeaders()
    if (Reflect.ownKeys(transport).length === 0) return connection
    const merged = mergeHeaderLayers([
      { layer: 'transport', headers: transport },
      { layer: 'sdk-attribution', headers: attributionHeaders() },
      { layer: 'auth', headers: connection.headers },
    ])
    return Object.freeze({
      ...connection,
      headers: merged.headers,
      sensitiveHeaderNames: Object.freeze([
        ...new Set([...(connection.sensitiveHeaderNames ?? []), ...merged.sensitiveHeaderNames]),
      ]),
    })
  }

  /**
   * The shared pipeline: guard, build, send, classify, decode, bound, translate.
   */
  private async * run(
    options: GenerateOptions,
    connection: HttpConnection,
    model: ResolvedModelInfo,
    context?: ModelInvocationContext,
    wireBodyCache: PreparedWireBodyCache = {},
  ): AsyncGenerator<StreamChunk> {
    context?.declareProviderAttemptAccounting?.()
    if (options.messages.some(message => contentHasImage(message.content))
      && model.inputModalities?.includes('image') !== true) {
      throw new ModelError(
        `${this.displayName} model "${options.model}" does not accept image input`,
        MODEL_ERROR_CODES.UNSUPPORTED_CONTENT,
      )
    }

    const request: ProviderRequest = {
      options,
      model,
      connection,
      maxTokens: options.maxTokens ?? model.defaultMaxTokens ?? connection.defaultMaxTokens,
    }

    // One controller for our own teardown, fused with the caller's. Aborting ours
    // in `finally` is what tears down an in-flight response when the consumer
    // stops reading early, instead of leaking the connection.
    const consumer = new AbortController()
    const requestTimeoutMs = positiveFinite(
      connection.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    const timeout = AbortSignal.timeout(requestTimeoutMs)
    const signal = AbortSignal.any([
      consumer.signal,
      timeout,
      ...options.signal === undefined ? [] : [options.signal],
    ])
    const maxRequestBytes = positiveInteger(
      connection.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxRequestBytes',
    )
    const maxResponseBytes = positiveInteger(
      connection.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    )
    const maxResponseChunks = positiveInteger(
      connection.maxResponseChunks ?? DEFAULT_MAX_RESPONSE_CHUNKS,
      'maxResponseChunks',
    )
    const maxSseEvents = positiveInteger(
      connection.maxSseEvents ?? DEFAULT_MAX_SSE_EVENTS,
      'maxSseEvents',
    )
    const maxSseEventChars = positiveInteger(
      connection.maxSseEventChars ?? DEFAULT_MAX_SSE_EVENT_CHARS,
      'maxSseEventChars',
    )
    const maxErrorBodyBytes = positiveInteger(
      connection.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
      'maxErrorBodyBytes',
    )
    const requestLoggerTimeoutMs = positiveFinite(
      connection.requestLoggerTimeoutMs ?? DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
      'requestLoggerTimeoutMs',
    )

    let admissionFailure: { readonly value: unknown } | undefined
    let ownedResponse: Response | undefined
    try {
      signal.throwIfAborted()
      const preparedBody = await (wireBodyCache.prepared ??= this.prepareWireBody(
        request,
        maxRequestBytes,
        signal,
      ))
      const wireBody = preparedBody.value
      const body = preparedBody.encoded
      const bodyBytes = preparedBody.bytes
      const endpoint = endpointUrl(
        connection.baseUrl,
        this.endpointPath(request),
        connection.allowInsecureHttp ?? false,
      )
      const url = endpoint.href
      const origin = endpoint.origin
      const headers = connection.headers

      // Logging is deliberately best-effort. A full disk or broken debug sink
      // must not turn a valid provider request into an application outage.
      try {
        const loggerSignal = AbortSignal.any([signal, AbortSignal.timeout(requestLoggerTimeoutMs)])
        await raceWithSignal(Promise.resolve(this.observeRequest({
          schemaVersion: 1,
          type: 'provider-request',
          id: requestLogId(),
          timestamp: new Date().toISOString(),
          provider: options.provider,
          model: options.model,
          method: 'POST',
          url,
          headers: redactHeaders(headers, connection.sensitiveHeaderNames),
          body: wireBody,
          bodyBytes,
        })), loggerSignal)
      } catch {
        // Contained by contract; see `observeRequest` above.
      }

      let attempt: ProviderAttemptHandle | undefined
      let dispatchState: 'not-sent' | 'sent' | 'unknown' = 'not-sent'
      let httpStatus: number | undefined
      let providerRequestId: string | undefined
      let attemptStatus: 'success' | 'error' | 'aborted' | 'unknown' = 'unknown'
      let attemptUsage: UsageCounters | undefined
      let attemptError: SafeErrorRecord | undefined
      try {
        signal.throwIfAborted()
        try {
          attempt = await context?.startProviderAttempt?.({
            provider: options.provider,
            model: options.model,
            method: 'POST',
            origin,
          }, signal)
        } catch (error: unknown) {
          admissionFailure = { value: error }
          throw error
        }
        signal.throwIfAborted()
        dispatchState = 'unknown'
        const fetchImplementation = connection.fetch ?? globalThis.fetch
        const pendingResponse = fetchImplementation(url, {
          method: 'POST',
          headers,
          body,
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

        if (!response.ok) throw await this.httpFailure(response, origin, maxErrorBodyBytes, signal)
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (mediaType !== 'text/event-stream') {
          throw new ModelError(
            `${this.displayName} response is not text/event-stream`,
            HTTP_PROVIDER_ERROR_CODES.STREAM_MEDIA_TYPE_INVALID,
          )
        }
        if (response.body === null) {
          throw new ModelError(
            `${this.displayName} returned no response body`,
            MODEL_ERROR_CODES.STREAM_CLOSED,
          )
        }

        const declaredLength = response.headers.get('content-length')
        if (declaredLength !== null && /^\d+$/.test(declaredLength)
          && Number(declaredLength) > maxResponseBytes) {
          throw new ModelError(
            `${this.displayName} response exceeds the ${maxResponseBytes}-byte limit`,
            MODEL_ERROR_CODES.TRANSPORT,
          )
        }
        const idleDeadline = createStreamIdleDeadline(
          connection.streamIdleTimeoutMs,
          this.displayName,
          30_000,
        )
        const events = parseSseBounded(boundedResponseBody(
          response.body,
          maxResponseBytes,
          maxResponseChunks,
          this.displayName,
          signal,
        ), idleDeadline.activity, 30_000, {
          maxEvents: maxSseEvents,
          maxEventChars: maxSseEventChars,
        })
        const translated = requireTerminalFinish(this.translate(events, request), this.displayName)
        for await (const chunk of withAbortSignal(idleDeadline.guard(translated), signal)) {
          if (chunk.type === 'usage') {
            attemptUsage = chunk.usage
            const validated = validateUsageCounters(chunk.usage, true)
            // Partial and malformed reports remain provider-attempt evidence but
            // never escape as the SDK's exact TokenUsage contract.
            if (!validated.complete) continue
            yield { type: 'usage', usage: validated.reported as TokenUsage }
            continue
          }
          if (chunk.type === 'finish') {
            attemptStatus = chunk.reason.kind === 'aborted' ? 'aborted'
              : chunk.reason.kind === 'error' ? 'error' : 'success'
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              attemptError = safeProviderFailure(chunk.reason.failure)
            }
          }
          yield chunk
        }
      } catch (error: unknown) {
        if (admissionFailure !== undefined && error === admissionFailure.value) throw error
        const mapped = timeout.aborted && options.signal?.aborted !== true
          ? new ModelError(
            `${this.displayName} request exceeded its ${requestTimeoutMs}ms time limit`,
            MODEL_ERROR_CODES.TIMEOUT,
            { cause: error },
          )
          : signal.aborted
            ? abortError(this.displayName, error)
            : normalizeHttpBoundaryError(
              error,
              `${this.displayName} request to ${origin} failed`,
            )
        attemptStatus = mapped.code === MODEL_ERROR_CODES.ABORTED ? 'aborted' : 'error'
        attemptError = safeProviderFailure(mapped.failure)
        throw mapped
      } finally {
        attempt?.end({
          status: attemptStatus,
          dispatchState,
          ...attemptUsage === undefined ? {} : { reported: attemptUsage },
          ...httpStatus === undefined ? {} : { httpStatus },
          ...providerRequestId === undefined ? {} : { providerRequestId },
          ...attemptError === undefined ? {} : { error: attemptError },
        })
      }
    } catch (error: unknown) {
      if (options.signal?.aborted === true) throw abortError(this.displayName, error)
      if (timeout.aborted) {
        throw new ModelError(
          `${this.displayName} request exceeded its ${requestTimeoutMs}ms time limit`,
          MODEL_ERROR_CODES.TIMEOUT,
          { cause: error },
        )
      }
      if (admissionFailure !== undefined && error === admissionFailure.value) throw error
      throw normalizeHttpBoundaryError(error, `${this.displayName} stream failed`)
    } finally {
      consumer.abort(new Error(`${this.displayName} stream consumer stopped`))
      if (ownedResponse !== undefined) await cancelResponseBody(ownedResponse)
    }
  }

  private async prepareWireBody(
    request: ProviderRequest,
    maxRequestBytes: number,
    signal: AbortSignal,
  ): Promise<PreparedWireBody> {
    signal.throwIfAborted()
    const value = await raceWithSignal(Promise.resolve(this.buildBody(request)), signal)
    const encoded = JSON.stringify(value)
    const bytes = new TextEncoder().encode(encoded).byteLength
    if (bytes > maxRequestBytes) {
      throw new ModelError(
        `${this.displayName} request exceeds the ${maxRequestBytes}-byte limit`,
        MODEL_ERROR_CODES.INVALID_REQUEST,
      )
    }
    return Object.freeze({ value, encoded, bytes })
  }

  /** Turn a non-2xx response into a fully populated {@link ModelError}. */
  private async httpFailure(
    response: Response,
    url: string,
    maxBytes: number,
    signal: AbortSignal,
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
      message ?? `${this.displayName} error (HTTP ${response.status}) from ${url}`,
      this.providerErrorCode(response.status, detail),
      {
        cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      },
    )
  }
}
