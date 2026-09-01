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

import { ModelAdapter, type PreparedAdapterCall } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ModelFailure } from '@ai-agent-sdk/core'
import type {
  ModelInfo,
  ModelModality,
  ModelReasoningInfo,
  ProviderInfo,
  ResolvedModelInfo,
} from '@ai-agent-sdk/core'
import type { ResolvedRetryPolicy } from '@ai-agent-sdk/core'
import type { NativeToolName } from '@ai-agent-sdk/core'
import { AgentSdkError, MODEL_ERROR_CODES, ModelError, OBSERVATION_ERROR_CODES } from '@ai-agent-sdk/core'
import { contentHasImage } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import type { ModelInvocationContext } from '@ai-agent-sdk/core'
import type { ProviderAttemptHandle, SafeErrorRecord, TokenUsage } from '@ai-agent-sdk/core'
import { withIdleTimeout } from '@ai-agent-sdk/core'
import { parseSse, type SseEvent } from '../stream/sse.ts'
import { httpErrorCode, parseErrorBody, requestIdFrom, retryAfterMs } from './http-errors.ts'

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
  /** Maximum bytes read from a non-success response. */
  readonly maxErrorBodyBytes?: number
  /** Maximum time granted to the optional request logger. */
  readonly requestLoggerTimeoutMs?: number
  /** Permit cleartext HTTP explicitly, for trusted local development endpoints only. */
  readonly allowInsecureHttp?: boolean
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
  protected abstract connect(provider: string, signal?: AbortSignal): Promise<HttpConnection>

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
  ): AsyncGenerator<StreamChunk>

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

  override async listModels(provider: string): Promise<readonly ModelInfo[]> {
    const connection = await this.connect(provider)
    return connection.models.map(model => catalogModelInfo(provider, model))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    return this.modelInfoFor(await this.connect(provider, signal), provider, model)
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
    const connection = await this.connect(provider, signal)
    const info = this.modelInfoFor(connection, provider, model)
    return {
      model: info,
      stream: (options, invocation = context) => this.run(options, connection, info, invocation),
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
    const connection = await this.connect(options.provider, options.signal)
    const info = this.modelInfoFor(connection, options.provider, options.model)
    yield* this.run(options, connection, info, context)
  }

  /** Resolve exact-model metadata from the catalog, falling back to config defaults. */
  protected modelInfoFor(
    connection: HttpConnection,
    provider: string,
    model: string,
  ): ResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    return {
      // An uncatalogued model is treated as text-only. Claiming an unverified
      // image capability would let a caller persist input that the endpoint
      // rejects on this and every later turn.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : catalogModelInfo(provider, configured),
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.defaultMaxTokens,
      maxOutputTokens: configured?.maxTokens ?? connection.defaultMaxTokens,
      ...configured?.reasoning === undefined ? {} : { reasoning: configured.reasoning },
      ...configured?.outputModalities === undefined ? {} : { outputModalities: configured.outputModalities },
    }
  }

  /**
   * The shared pipeline: guard, build, send, classify, decode, bound, translate.
   */
  private async * run(
    options: GenerateOptions,
    connection: HttpConnection,
    model: ResolvedModelInfo,
    context?: ModelInvocationContext,
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
    const maxErrorBodyBytes = positiveInteger(
      connection.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
      'maxErrorBodyBytes',
    )
    const requestLoggerTimeoutMs = positiveFinite(
      connection.requestLoggerTimeoutMs ?? DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
      'requestLoggerTimeoutMs',
    )

    try {
      const wireBody = await raceWithSignal(Promise.resolve(this.buildBody(request)), signal)
      const body = JSON.stringify(wireBody)
      const bodyBytes = new TextEncoder().encode(body).byteLength
      if (bodyBytes > maxRequestBytes) {
        throw new ModelError(
          `${this.displayName} request exceeds the ${maxRequestBytes}-byte limit`,
          MODEL_ERROR_CODES.INVALID_REQUEST,
        )
      }
      const endpoint = endpointUrl(
        connection.baseUrl,
        this.endpointPath(request),
        connection.allowInsecureHttp ?? false,
      )
      const url = endpoint.href
      const origin = endpoint.origin
      const headers = { ...this.baseHeaders(), ...connection.headers }

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
          headers: redactHeaders(headers),
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
      let attemptUsage: TokenUsage | undefined
      let attemptError: SafeErrorRecord | undefined
      try {
        attempt = await context?.startProviderAttempt?.({
          provider: options.provider,
          model: options.model,
          method: 'POST',
          origin,
        }, signal)
        dispatchState = 'unknown'
        const response = await raceWithSignal(fetch(url, {
          method: 'POST',
          headers,
          body,
          signal,
          redirect: 'error',
        }), signal)
        dispatchState = 'sent'
        httpStatus = response.status
        providerRequestId = requestIdFrom(response.headers)

        if (!response.ok) throw await this.httpFailure(response, origin, maxErrorBodyBytes, signal)
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
        const events = parseSse(boundedResponseBody(
          response.body,
          maxResponseBytes,
          maxResponseChunks,
          this.displayName,
        ))
        const bounded = withIdleTimeout(
          events,
          connection.streamIdleTimeoutMs,
          () => new ModelError(
            `${this.displayName} stream idle for more than ${connection.streamIdleTimeoutMs}ms`,
            MODEL_ERROR_CODES.TIMEOUT,
          ),
        )
        for await (const chunk of withAbortSignal(this.translate(bounded, request), signal)) {
          if (chunk.type === 'usage') attemptUsage = chunk.usage
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
        if (error instanceof AgentSdkError
          && error.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE) throw error
        const mapped = timeout.aborted && options.signal?.aborted !== true
          ? new ModelError(
            `${this.displayName} request exceeded its ${requestTimeoutMs}ms time limit`,
            MODEL_ERROR_CODES.TIMEOUT,
            { cause: error },
          )
          : signal.aborted
            ? abortError(this.displayName, error)
            : error instanceof ModelError
              ? error
              : new ModelError(
                `${this.displayName} request to ${origin} failed`,
                MODEL_ERROR_CODES.TRANSPORT,
                { cause: error },
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
      if (error instanceof AgentSdkError
        && error.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE) throw error
      if (error instanceof ModelError) throw error
      throw new ModelError(
        `${this.displayName} stream failed`,
        MODEL_ERROR_CODES.TRANSPORT,
        { cause: error },
      )
    } finally {
      consumer.abort(new Error(`${this.displayName} stream consumer stopped`))
    }
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

function boundedResponseBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  maxChunks: number,
  displayName: string,
): ReadableStream<Uint8Array> {
  let bytes = 0
  let chunks = 0
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      chunks++
      bytes += chunk.byteLength
      if (chunks > maxChunks) {
        throw new ModelError(
          `${displayName} response exceeds the ${maxChunks}-chunk limit`,
          MODEL_ERROR_CODES.TRANSPORT,
        )
      }
      if (bytes > maxBytes) {
        throw new ModelError(
          `${displayName} response exceeds the ${maxBytes}-byte limit`,
          MODEL_ERROR_CODES.TRANSPORT,
        )
      }
      controller.enqueue(chunk)
    },
  }))
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), signal)
      if (done) break
      if (value === undefined) continue
      const remaining = maxBytes - bytes
      if (remaining <= 0) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        return `${text}\n[error body truncated at ${maxBytes} bytes]`
      }
      const kept = value.byteLength <= remaining ? value : value.subarray(0, remaining)
      bytes += kept.byteLength
      text += decoder.decode(kept, { stream: true })
      if (kept.byteLength !== value.byteLength) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        return `${text}${decoder.decode()}\n[error body truncated at ${maxBytes} bytes]`
      }
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('operation aborted')
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function* withAbortSignal<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      const next = await raceWithSignal(iterator.next(), signal)
      if (next.done === true) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) {
      const close = iterator.return?.bind(iterator)
      if (close !== undefined) {
        const closing = Promise.resolve().then(async () => { await close() })
        await waitForSettlement(closing, 30_000)
      }
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

function endpointUrl(baseUrl: string, path: string, allowInsecureHttp: boolean): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch (error) {
    throw new ModelError('provider baseUrl is not a valid absolute URL', MODEL_ERROR_CODES.INVALID_REQUEST, { cause: error })
  }
  if (base.username.length > 0 || base.password.length > 0) {
    throw new ModelError('provider baseUrl must not contain credentials', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  if (base.search.length > 0 || base.hash.length > 0) {
    throw new ModelError('provider baseUrl must not contain a query or fragment', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  if (base.protocol !== 'https:' && !(allowInsecureHttp && base.protocol === 'http:')) {
    throw new ModelError(
      'provider baseUrl must use HTTPS unless allowInsecureHttp is explicitly enabled',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  const normalizedBase = base.href.replace(/\/+$/, '')
  let endpoint: URL
  try {
    endpoint = new URL(`${normalizedBase}${path}`)
  } catch (error) {
    throw new ModelError('provider endpoint path produced an invalid URL', MODEL_ERROR_CODES.INVALID_REQUEST, { cause: error })
  }
  if (endpoint.origin !== base.origin) {
    throw new ModelError('provider endpoint path must remain on the configured origin', MODEL_ERROR_CODES.INVALID_REQUEST)
  }
  return endpoint
}

function safeProviderFailure(failure: ModelFailure): SafeErrorRecord {
  return Object.freeze({
    type: 'ModelError',
    message: 'provider attempt failed; inspect the stable code and request ID',
    code: failure.code,
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

/** Header names whose values must never enter diagnostic logs. */
const SENSITIVE_HEADER = /authorization|api[-_]?key|token|secret|cookie|account-id/i

/** Detach headers and redact credentials while retaining useful protocol metadata. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SENSITIVE_HEADER.test(name) ? '[REDACTED]' : value,
  ]))
}

function requestLogId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Project a catalog entry into advisory model metadata. */
function catalogModelInfo(provider: string, model: ProviderCatalogModel): ModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
    ...model.outputModalities === undefined ? {} : { outputModalities: model.outputModalities },
    ...model.nativeTools === undefined ? {} : { nativeTools: model.nativeTools },
  }
}

/** The caller's own cancellation, reported as such rather than as a transport fault. */
function abortError(displayName: string, cause: unknown): ModelError {
  return new ModelError(
    `${displayName} request aborted by caller`,
    MODEL_ERROR_CODES.ABORTED,
    { cause },
  )
}
