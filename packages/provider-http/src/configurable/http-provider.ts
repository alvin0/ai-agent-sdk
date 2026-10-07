import { configuredConnection } from './connection.ts'
import { HttpCatalog } from './catalog.ts'
import { snapshotConfiguration } from './configuration-snapshot.ts'
import type { HttpProviderOptions } from './http-options.ts'
/**
 * Build a provider from CONFIGURATION instead of from a subclass.
 *
 * This is the path most endpoints should take. Adding an endpoint that speaks a
 * protocol this package already implements — an OpenAI-compatible gateway, a
 * self-hosted server, a proxy, a regional deployment — should not require another
 * adapter class, another folder, or an edit to this package's build config. It
 * requires a config object:
 *
 * ```ts
 * const openrouter = createHttpProvider({
 *   displayName: 'OpenRouter',
 *   protocol: openAiResponsesProtocol,
 *   baseUrl: 'https://openrouter.ai/api/v1',
 *   auth: { kind: 'bearer', token: () => credentialStore.read('openrouter') },
 * })
 * registry.registerAdapter(['openrouter'], openrouter)
 * ```
 *
 * Subclass {@link HttpModelAdapter} directly only when the endpoint's connection
 * facts cannot be expressed as data — request signing that depends on the request
 * body (AWS SigV4), or a credential exchange with its own state machine. Note that
 * OAuth is NOT such a case: `auth: { kind: 'dynamic' }` resolves headers per
 * operation, which is enough for a token that refreshes.
 *
 * @module ai-agent-sdk/providers/http-provider
 */

import type {
  ModelCatalogOptions,
  ModelCatalogSnapshot,
  ModelInfo,
  ModelInvocationContext,
  ResolvedModelInfo,
} from '@alvin0/ai-agent-sdk-core'
import { resolveRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import type { SseEvent } from '../stream/sse.ts'
import {
  HttpModelAdapter,
  type HttpConnection,
  type ProviderRequest,
  type ProviderRequestLogRecord,
  type ProviderResponseLogRecord,
} from '../base/http-adapter.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { resolveDialect } from '../protocol/protocol.ts'
import { catalogModelInfo, resolvedCatalogModelInfo } from '../base/transport.ts'
import { appendQuery } from '../common/request-path.ts'
import { mergeRequestBody } from '../common/body-merge.ts'

export type { CredentialSource, AuthScheme, RequestContext, ModelDiscoveryContext, HttpProviderOptions }
  from './http-options.ts'

/**
 * A provider whose every endpoint fact is configuration.
 *
 * Kept private: the exported surface is {@link createHttpProvider}, so this class
 * is free to change and callers cannot come to depend on its shape.
 */
class ConfiguredHttpAdapter<Dialect extends object> extends HttpModelAdapter {
  protected readonly displayName: string

  private readonly options: HttpProviderOptions<Dialect>
  private readonly dialect: Dialect
  private readonly retry: ResolvedRetryPolicy
  private readonly catalogCache: HttpCatalog<Dialect>

  constructor(options: HttpProviderOptions<Dialect>) {
    super()
    this.options = snapshotConfiguration(options)
    this.displayName = options.displayName
    this.dialect = resolveDialect(options.protocol, options.dialect)
    this.retry = resolveRetryPolicy(options.retryPolicy, `${options.displayName}.retryPolicy`)
    this.catalogCache = new HttpCatalog(this.options)
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.retry
  }

  override listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    if (!this.hasStaticCatalog()) return super.listModels(provider, signal)
    signal?.throwIfAborted()
    return Promise.resolve(this.staticModels(provider))
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    if (!this.hasStaticCatalog()) return super.resolveModel(provider, model, signal)
    signal?.throwIfAborted()
    return Promise.resolve(this.decorateModel(resolvedCatalogModelInfo(
      provider,
      model,
      this.options.models ?? [],
      this.options.defaultMaxTokens,
      this.options.defaultContextWindow,
    )))
  }

  override async modelCatalog(
    provider: string,
    options: ModelCatalogOptions = {},
  ): Promise<ModelCatalogSnapshot> {
    if (this.hasStaticCatalog()) {
      options.signal?.throwIfAborted()
      return Object.freeze({
        provider: Object.freeze({ id: provider, name: this.displayName }),
        state: 'static',
        revision: 'http-static',
        models: this.staticModels(provider),
        observedAt: new Date().toISOString(),
      })
    }
    const snapshot = await super.modelCatalog(provider, options)
    if (this.catalogCache.failed) {
      throw new Error('HTTP provider model catalog is unavailable')
    }
    return snapshot
  }

  protected override decorateModel(base: ResolvedModelInfo): ResolvedModelInfo {
    return this.options.describeModel?.(base, this.dialect) ?? base
  }

  private hasStaticCatalog(): boolean {
    return this.options.models !== undefined || this.options.discoverModels === undefined
  }

  private staticModels(provider: string): readonly ModelInfo[] {
    return Object.freeze((this.options.models ?? []).map(model =>
      Object.freeze(catalogModelInfo(provider, model))))
  }

  protected override connect(
    provider: string, signal?: AbortSignal, context?: ModelInvocationContext, model?: string,
  ): Promise<HttpConnection> {
    return configuredConnection({
      options: this.options, dialect: this.dialect, retry: this.retry,
      catalogCache: this.catalogCache, displayName: this.displayName,
    }, provider, { signal, context, model })
  }

  protected override baseHeaders(): Record<string, string> {
    return {}
  }

  protected override observeRequest(record: ProviderRequestLogRecord): Promise<void> | void {
    return this.options.requestLogger?.(record)
  }

  protected override observeResponse(record: ProviderResponseLogRecord): Promise<void> | void {
    return this.options.responseLogger?.(record)
  }

  protected override providerErrorCode(status: number, detail: string): string {
    return this.options.errorCode?.(status, detail) ?? super.providerErrorCode(status, detail)
  }

  protected override endpointPath(request: ProviderRequest): string {
    const base = this.options.path ?? this.options.protocol.endpointPath(request, this.dialect)
    const withRouteQuery = appendQuery(base, this.options.query)
    // `auth`'s query-string credentials (`{ kind: 'query', ... }`) always win,
    // same as any other auth-layer value — see decision 12's merge order.
    return request.connection.queryOverrides === undefined
      ? withRouteQuery
      : appendQuery(withRouteQuery, request.connection.queryOverrides)
  }

  protected override buildBody(request: ProviderRequest): unknown | Promise<unknown> {
    const serialized = this.options.protocol.serialize(request, this.dialect)
    const withRouteBody = this.options.body === undefined
      ? serialized
      : mergeRequestBody(serialized, this.options.body)
    // The model's own body fields win over the route's, per decision 12's
    // "route, model, agent" precedence.
    const modelBody = this.options.models?.find(candidate => candidate.id === request.model.id)?.body
    const withModelBody = modelBody === undefined
      ? withRouteBody
      : mergeRequestBody(withRouteBody, modelBody)
    // The agent's own body fields win over both, being the last, most specific tier.
    const merged = request.providerOptionsBody === undefined
      ? withModelBody
      : mergeRequestBody(withModelBody, request.providerOptionsBody)
    return this.options.transformRequest === undefined
      ? merged
      : this.options.transformRequest(merged, {
        provider: request.options.provider,
        model: request.model.id,
        ...request.agentId === undefined ? {} : { agentId: request.agentId },
        ...request.options.signal === undefined ? {} : { signal: request.options.signal },
      })
  }

  protected override translate(
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
  ): AsyncGenerator<ProviderProtocolChunk> {
    return this.options.protocol.translate(events, request, this.displayName)
  }
}

/** Validate resource bounds before retaining a provider-controlled catalog. */

/**
 * Create a provider adapter from configuration.
 * @param options - protocol, endpoint, credential, and optional capability hooks.
 * @returns an adapter ready for `registry.registerAdapter`.
 */
export function createHttpProvider<Dialect extends object>(
  options: HttpProviderOptions<Dialect>,
): HttpModelAdapter {
  return new ConfiguredHttpAdapter(options)
}
