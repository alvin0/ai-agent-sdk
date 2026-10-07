import { decodeProviderSse } from './sse-decode.ts'
import {
  resolveSseLimits,
  type HttpConnection,
  type ProviderRequest,
  type ProviderRequestLogRecord,
  type ProviderResponseLogRecord,
  type PreparedWireBodyCache,
  type ResolvedSseLimits,
} from './http-types.ts'
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
import type { ModelInfo, ProviderInfo, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import { contentHasDocument, contentHasImage } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { SseEvent } from '../stream/sse.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { captureTransportConnection } from '../transport/connection.ts'
import type { HttpTransportSession, PreparedWireBody } from '../transport/session.ts'
import { transportStream } from '../transport/stream.ts'
import { httpErrorCode } from './http-errors.ts'
import { catalogModelInfo, raceWithSignal, redactHeaders, resolvedCatalogModelInfo } from './transport.ts'

export { redactHeaders } from './transport.ts'
export {
  DEFAULT_MAX_ERROR_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../transport/limits.ts'

export { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from './http-types.ts'
export type {
  ProviderCatalogModel, HttpConnection, ProviderRequest, ProviderRequestLogRecord,
  ProviderRequestLogger, ProviderResponseLogRecord, ProviderResponseLogger,
} from './http-types.ts'

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
   * @param context - correlation/accounting context, when the caller has one.
   * @param model - the exact model id, when the caller already knows it (absent
   *   for `listModels()`, which resolves a connection before any one model is
   *   chosen).
   */
  protected abstract connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
    model?: string,
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
   * Observe the exact, header-redacted wire response once a stream ends.
   *
   * The default is a no-op so library users do not silently persist model
   * output. Fired best-effort from a `finally`, after the consumer has
   * already seen every chunk — a slow or failing sink here can neither delay
   * nor break the real call.
   */
  protected observeResponse(_record: ProviderResponseLogRecord): Promise<void> | void {}

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
    const connection = this.captureConnection(await this.connect(provider, signal, undefined, model))
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
    const connection = this.captureConnection(await this.connect(provider, signal, context, model))
    const info = this.decorateModel(this.modelInfoFor(connection, provider, model), connection)
    const wireBody: PreparedWireBodyCache = {}
    return {
      model: info,
      stream: (options, invocation = context) => this.run(
        options,
        connection,
        info,
        { context: invocation, wireBodyCache: wireBody },
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
  private async * runResolving(
    options: GenerateOptions, context?: ModelInvocationContext,
  ): AsyncGenerator<StreamChunk> {
    context?.declareProviderAttemptAccounting?.()
    const connection = this.captureConnection(
      await this.connect(options.provider, options.signal, context, options.model),
    )
    const info = this.decorateModel(
      this.modelInfoFor(connection, options.provider, options.model),
      connection,
    )
    yield* this.run(options, connection, info, { context, wireBodyCache: {} })
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
    invocation: { context: ModelInvocationContext | undefined; wireBodyCache: PreparedWireBodyCache },
  ): AsyncGenerator<StreamChunk> {
    const { context, wireBodyCache } = invocation
    context?.declareProviderAttemptAccounting?.()
    this.assertModalities(options, model)

    const request = this.providerRequest(options, connection, model, context)

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

  private assertModalities(options: GenerateOptions, model: ResolvedModelInfo): void {
    // Undefined `inputModalities` is UNKNOWN, not a negative capability claim
    // (see `resolvedCatalogModelInfo`'s doc comment) — the registry's own
    // permissive default (text + image + document) applies. This guard is a
    // fallback for direct adapter usage that bypasses `ModelRegistry` (whose
    // own `streamAdapter()` already enforces `imagePolicy`/`documentPolicy`
    // against the DEFAULTED modalities before ever reaching here), so it must
    // only reject a modality the catalog EXPLICITLY excludes.
    if (options.messages.some(message => contentHasImage(message.content))
      && model.inputModalities !== undefined && !model.inputModalities.includes('image')) {
      throw new ModelError(
        `${this.displayName} model "${options.model}" does not accept image input`,
        MODEL_ERROR_CODES.UNSUPPORTED_CONTENT,
      )
    }
    if (options.messages.some(message => contentHasDocument(message.content))
      && model.inputModalities !== undefined && !model.inputModalities.includes('document')) {
      throw new ModelError(
        `${this.displayName} model "${options.model}" does not accept document input`,
        MODEL_ERROR_CODES.UNSUPPORTED_CONTENT,
      )
    }

  }

  private providerRequest(
    options: GenerateOptions, connection: HttpConnection, model: ResolvedModelInfo,
    context: ModelInvocationContext | undefined,
  ): ProviderRequest {
    const resolvedMaxTokens = options.maxTokens ?? model.defaultMaxTokens ?? connection.defaultMaxTokens
    return {
      options,
      model,
      connection,
      ...(resolvedMaxTokens === undefined ? {} : { maxTokens: resolvedMaxTokens }),
      ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
      ...(context?.providerOptions?.body === undefined ? {} : { providerOptionsBody: context.providerOptions.body }),
    }

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
  private decodeSse(
    session: HttpTransportSession, request: ProviderRequest, sse: ResolvedSseLimits,
  ): AsyncIterable<StreamChunk> {
    const adapter = this
    return decodeProviderSse(session, request, sse, {
      get displayName() { return adapter.displayName },
      translate: (events, request) => this.translate(events, request),
      emitResponseLog: (request, session, frames) => this.emitResponseLog(request, session, frames),
    })
  }

  /** Best-effort delivery of one response record; see `observeResponse`'s doc comment. */
  private async emitResponseLog(
    request: ProviderRequest,
    session: HttpTransportSession,
    frames: readonly SseEvent[],
  ): Promise<void> {
    try {
      await this.observeResponse({
        schemaVersion: 1,
        type: 'provider-response',
        id: session.requestLogId,
        timestamp: new Date().toISOString(),
        provider: request.options.provider,
        model: request.options.model,
        status: session.response.status,
        headers: redactHeaders(Object.fromEntries(session.response.headers.entries())),
        ...(session.providerRequestId === undefined ? {} : { providerRequestId: session.providerRequestId }),
        frames,
      })
    } catch {
      // Contained by contract; see `observeResponse` above.
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
