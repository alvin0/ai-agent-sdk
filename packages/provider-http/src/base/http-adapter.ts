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
 * The risky half of that list — signal fusion, request bounds, the diagnostic
 * observer, attempt accounting, redirect refusal, status mapping, teardown — now
 * lives in {@link ../transport/session.withTransportSession} so a second pipeline
 * cannot reimplement it slightly differently. What stays in this file is what is
 * genuinely generation's: the modality guard, the catalog, the serialized-body
 * cache for one prepared call, and {@link HttpModelAdapter.decodeSse} — the SSE
 * half, unchanged, applied to a response that already cleared every guard.
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
import type { NativeToolName } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import { contentHasDocument, contentHasImage } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { TokenUsage } from '@alvin0/ai-agent-sdk-core'
import { validateUsageCounters } from '@alvin0/ai-agent-sdk-core'
import { parseSseBounded } from '../stream/parser.ts'
import type { SseEvent } from '../stream/sse.ts'
import { DEFAULT_MAX_SSE_EVENT_CHARS, DEFAULT_MAX_SSE_EVENTS } from '../stream/config.ts'
import { createStreamIdleDeadline } from '../stream/idle-deadline.ts'
import { requireTerminalFinish } from '../stream/terminal.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'
import { captureTransportConnection, type HttpTransportConnection } from '../transport/connection.ts'
import { positiveInteger } from '../transport/limits.ts'
import type { HttpTransportSession, PreparedWireBody } from '../transport/session.ts'
import { transportStream } from '../transport/stream.ts'
import { httpErrorCode } from './http-errors.ts'
import {
  boundedResponseBody,
  catalogModelInfo,
  raceWithSignal,
  resolvedCatalogModelInfo,
} from './transport.ts'

export { redactHeaders } from './transport.ts'
export {
  DEFAULT_MAX_ERROR_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../transport/limits.ts'

/** Default idle bound: five minutes without a single byte is a hung stream. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

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
 * Everything needed to issue ONE generation request, captured as a single snapshot.
 *
 * The transport half — endpoint, headers, bounds, retry policy — is
 * {@link HttpTransportConnection} and is shared with every other pipeline in this
 * package. What this interface adds is the part only generation has: the SSE
 * decoding bounds and the advisory model catalog. The field set and the optionality
 * of every field are unchanged from before the split, so existing provider
 * configurations satisfy it exactly as they did.
 *
 * The catalog stays here deliberately. Embedding routes carry a catalog with
 * different semantics, and folding the two into one shape is precisely the
 * conflation this split avoids.
 */
export interface HttpConnection extends HttpTransportConnection {
  /** Maximum idle interval while a read is outstanding. */
  readonly streamIdleTimeoutMs: number
  /** Maximum decoded SSE events accepted from one response. */
  readonly maxSseEvents?: number
  /** Maximum characters accepted in one decoded SSE event. */
  readonly maxSseEventChars?: number
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

/**
 * The serialized body of ONE prepared call, kept across repeated `stream()` calls.
 *
 * This stays with the pipeline rather than moving into the transport: the transport
 * issues one request and has no notion of a prepared call to cache against, and a
 * cache that outlived a request would be a way for one call's body to reach another
 * call's wire.
 */
interface PreparedWireBodyCache {
  prepared?: Promise<PreparedWireBody>
}

/** The decoding bounds the SSE pipeline adds on top of the transport's. */
interface ResolvedSseLimits {
  /** Maximum decoded SSE events accepted from one response. */
  readonly maxEvents: number
  /** Maximum characters accepted in one decoded SSE event. */
  readonly maxEventChars: number
}

/**
 * Resolve the SSE bounds before any transport work starts.
 *
 * Deliberately validated in the pipeline and not inside `decodeSse`: an
 * unusable bound is a configuration error, and configuration errors must not
 * arrive after a provider attempt has been opened and a request sent.
 * @param connection - the snapshot this call is bound to.
 * @returns defaulted, validated event bounds.
 */
function resolveSseLimits(connection: HttpConnection): ResolvedSseLimits {
  return Object.freeze({
    maxEvents: positiveInteger(
      connection.maxSseEvents ?? DEFAULT_MAX_SSE_EVENTS,
      'maxSseEvents',
    ),
    maxEventChars: positiveInteger(
      connection.maxSseEventChars ?? DEFAULT_MAX_SSE_EVENT_CHARS,
      'maxSseEventChars',
    ),
  })
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
    return captureTransportConnection(connection, this.baseHeaders())
  }

  /**
   * The generation pipeline: guard the modalities, then hand one request to the
   * shared transport chain with SSE decoding as its only pipeline-specific part.
   *
   * Still a generator, and deliberately so: the modality guard, the body
   * serialization and every transport step stay lazy until a consumer pulls, which
   * is the behaviour every existing caller of `stream()` already relies on.
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
    if (options.messages.some(message => contentHasDocument(message.content))
      && model.inputModalities?.includes('document') !== true) {
      throw new ModelError(
        `${this.displayName} model "${options.model}" does not accept document input`,
        MODEL_ERROR_CODES.UNSUPPORTED_CONTENT,
      )
    }

    const request: ProviderRequest = {
      options,
      model,
      connection,
      maxTokens: options.maxTokens ?? model.defaultMaxTokens ?? connection.defaultMaxTokens,
    }

    const sseLimits = resolveSseLimits(connection)
    const adapter = this
    yield* transportStream<StreamChunk>({
      connection,
      displayName: this.displayName,
      provider: options.provider,
      model: options.model,
      accept: 'text/event-stream',
      /**
       * Read by the transport AFTER the body is prepared, which is exactly where
       * the pipeline used to call it. A provider whose path computation fails
       * therefore still fails inside the transport's classification, and a
       * protocol that reports its routing decision from `endpointPath` still
       * reports it once, in the same place in the sequence, as before.
       */
      get path(): string {
        return adapter.endpointPath(request)
      },
      // The transport bounds and rejects this body; the cache that keeps it across
      // repeated `stream()` calls on one prepared call belongs to the pipeline.
      body: signal => wireBodyCache.prepared ??= this.prepareWireBody(request, signal),
      ...options.signal === undefined ? {} : { signal: options.signal },
      ...context === undefined ? {} : { context },
      errorCode: (status, detail) => this.providerErrorCode(status, detail),
      observeRequest: record => this.observeRequest(record),
    }, session => this.decodeSse(session, request, sseLimits))
  }

  /**
   * The SSE half: media type, bounds, idle deadline, translation, usage honesty.
   *
   * Everything this sees has already cleared the transport's guards — 2xx, no
   * redirect, attempt open, teardown owned — so what remains is only the format.
   * Abort racing is not repeated here: {@link transportStream} already iterates
   * this generator under the fused signal.
   * @param session - the guarded response and its attempt-evidence hooks.
   * @param request - the request this response answers.
   * @param sse - event bounds resolved before any transport work began.
   * @returns the provider's chunks, with incomplete usage held back.
   */
  private async * decodeSse(
    session: HttpTransportSession,
    request: ProviderRequest,
    sse: ResolvedSseLimits,
  ): AsyncGenerator<StreamChunk> {
    const response = session.response
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== session.accept) {
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

    const maxResponseBytes = session.limits.maxResponseBytes
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && /^\d+$/.test(declaredLength)
      && Number(declaredLength) > maxResponseBytes) {
      throw new ModelError(
        `${this.displayName} response exceeds the ${maxResponseBytes}-byte limit`,
        MODEL_ERROR_CODES.TRANSPORT,
      )
    }
    const idleDeadline = createStreamIdleDeadline(
      request.connection.streamIdleTimeoutMs,
      this.displayName,
      30_000,
    )
    const events = parseSseBounded(boundedResponseBody(
      response.body,
      maxResponseBytes,
      session.limits.maxResponseChunks,
      this.displayName,
      session.signal,
    ), idleDeadline.activity, 30_000, {
      maxEvents: sse.maxEvents,
      maxEventChars: sse.maxEventChars,
    })
    const translated = requireTerminalFinish(this.translate(events, request), this.displayName)
    for await (const chunk of idleDeadline.guard(translated)) {
      if (chunk.type === 'usage') {
        session.reportUsage(chunk.usage)
        const validated = validateUsageCounters(chunk.usage, true)
        // Partial and malformed reports remain provider-attempt evidence but
        // never escape as the SDK's exact TokenUsage contract.
        if (!validated.complete) continue
        yield { type: 'usage', usage: validated.reported as TokenUsage }
        continue
      }
      if (chunk.type === 'finish') {
        const status = chunk.reason.kind === 'aborted' ? 'aborted'
          : chunk.reason.kind === 'error' ? 'error' : 'success'
        session.reportOutcome(
          status,
          chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
            ? chunk.reason.failure
            : undefined,
        )
      }
      yield chunk
    }
  }

  private async prepareWireBody(
    request: ProviderRequest,
    signal: AbortSignal,
  ): Promise<PreparedWireBody> {
    signal.throwIfAborted()
    const value = await raceWithSignal(Promise.resolve(this.buildBody(request)), signal)
    const encoded = JSON.stringify(value)
    const bytes = new TextEncoder().encode(encoded).byteLength
    return Object.freeze({ value, encoded, bytes })
  }
}
