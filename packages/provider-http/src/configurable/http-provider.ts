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
import { resolveRetryPolicy, type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import { assertUsableApiKey } from '@alvin0/ai-agent-sdk-core'
import { attributionHeaders } from '@alvin0/ai-agent-sdk-core'
import { detachedFrozen } from '@alvin0/ai-agent-sdk-core'
import type { SseEvent } from '../stream/sse.ts'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_MAX_ERROR_BODY_BYTES,
  HttpModelAdapter,
  type HttpConnection,
  type ProviderCatalogModel,
  type ProviderRequest,
  type ProviderRequestLogger,
  type ProviderRequestLogRecord,
  type ProviderResponseLogger,
  type ProviderResponseLogRecord,
} from '../base/http-adapter.ts'
import type { ProviderProtocolChunk } from '../stream/types.ts'
import { resolveDialect, type WireProtocol } from '../protocol/protocol.ts'
import {
  observeCredentialOperation,
  observeModelCatalogOperation,
} from '../observation/operations.ts'
import {
  captureHeaderLayer,
  DEFAULT_TRANSPORT_HEADERS,
  mergeHeaderLayers,
} from '../common/header-layers.ts'
import type { HeaderContext } from '../common/endpoint-headers.ts'
import {
  catalogModelInfo,
  resolvedCatalogModelInfo,
} from '../base/transport.ts'
import { appendQuery } from '../common/request-path.ts'
import { mergeRequestBody } from '../common/body-merge.ts'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core/provider'
import { HTTP_PROVIDER_ERROR_CODES } from '../common/config.ts'

/** A credential, either literal or resolved per operation. */
export type CredentialSource = string | ((
  signal?: AbortSignal,
  context?: ModelInvocationContext,
) => string | Promise<string>)

/**
 * How requests are authenticated.
 *
 * `dynamic` is the escape hatch that keeps OAuth out of subclass territory: it is
 * called once per operation, so it can refresh a token, read a rotating secret, or
 * add account-scoping headers.
 */
export type AuthScheme =
  /** Unauthenticated — a local server, or an endpoint behind a network boundary. */
  | { kind: 'none' }
  /** `authorization: Bearer <token>`. */
  | { kind: 'bearer'; token: CredentialSource; label?: string }
  /** A named header, e.g. `x-api-key`. */
  | { kind: 'header'; name: string; value: CredentialSource; label?: string }
  /** Arbitrary headers resolved per operation. */
  | {
    kind: 'dynamic'
    resolve: (
      signal?: AbortSignal,
      context?: ModelInvocationContext,
      provider?: string,
    ) => Record<string, string> | Promise<Record<string, string>>
  }
  /**
   * A named query-string parameter, e.g. Azure's `?key=`. Never a header —
   * the value reaches the URL instead — but still resolved alongside every
   * other scheme and still redacted in logs by name.
   */
  | { kind: 'query'; name: string; value: CredentialSource; label?: string }

interface ResolvedAuth {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

/** Normalize a single scheme or an array of schemes into an array. */
function authSchemesOf(auth: AuthScheme | readonly AuthScheme[]): readonly AuthScheme[] {
  return Array.isArray(auth) ? auth : [auth as AuthScheme]
}

/** Union several name/value records, case-insensitively, failing fast on a name two entries both set. */
function unionByName(
  entries: readonly Readonly<Record<string, string>>[],
  kind: 'header' | 'query param',
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  const owners = new Map<string, number>()
  entries.forEach((entry, index) => {
    for (const [name, value] of Object.entries(entry)) {
      const lower = name.toLowerCase()
      const first = owners.get(lower)
      if (first !== undefined && first !== index) {
        throw new AgentSdkError(
          `Two auth schemes both produced the \`${lower}\` ${kind}`,
          HTTP_PROVIDER_ERROR_CODES.HEADER_COLLISION,
        )
      }
      owners.set(lower, index)
      output[name] = value
    }
  })
  return output
}

/** What `transformRequest` sees alongside the body. */
export interface RequestContext {
  /** Registered provider route. */
  readonly provider: string
  /** Exact model id for this call. */
  readonly model: string
  /** Stable code-owned agent identity, when this call belongs to one and the caller supplied it. */
  readonly agentId?: string
  readonly signal?: AbortSignal
}

/** What a model-discovery hook receives. */
export interface ModelDiscoveryContext {
  /** The endpoint base, with no trailing slash. */
  readonly baseUrl: string
  /** Every header the request would carry, including authentication. */
  readonly headers: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Additive runtime context; legacy discovery hooks may ignore it. */
  readonly provider?: string
  /** Additive invocation context; legacy discovery hooks may ignore it. */
  readonly context?: ModelInvocationContext
}

/** Configuration for {@link createHttpProvider}. */
export interface HttpProviderOptions<Dialect extends object> {
  /** Human-readable name used in every diagnostic. */
  displayName: string
  /** The wire protocol this endpoint speaks. */
  protocol: WireProtocol<Dialect>
  /** Endpoint base; the protocol's path is appended. */
  baseUrl: string
  /** Permit cleartext HTTP explicitly, for trusted local development only. */
  allowInsecureHttp?: boolean
  /** Captured fetch implementation for tests, custom runtimes, and transport policy. */
  fetch?: typeof globalThis.fetch
  /**
   * How to authenticate. An array resolves every scheme and unions their
   * headers — a gateway key alongside an upstream key, for instance. Each
   * entry's headers are marked sensitive and redacted in logs; two entries
   * producing the same header name fail fast, before either credential
   * resolves.
   */
  auth: AuthScheme | readonly AuthScheme[]
  /**
   * Per-endpoint protocol knobs, merged over the protocol's defaults.
   *
   * Partial, so a protocol can gain a knob without any endpoint needing an edit.
   */
  dialect?: Partial<Dialect>
  /** Extra static headers, or a resolver receiving `{ provider, agentId?, signal? }`. */
  headers?: Record<string, string> | ((ctx: HeaderContext) => Record<string, string>)
  /**
   * Override the request path every protocol would otherwise pick for itself
   * (e.g. an Azure OpenAI deployment path). Applies uniformly to every request
   * this endpoint sends; a protocol's own default stays in force when unset.
   */
  path?: string
  /**
   * Extra query-string parameters, or a resolver for them (e.g. Azure's
   * `api-version`). Never for secrets — a value here is NOT redacted in logs;
   * put a credential in `auth` instead.
   */
  query?: Record<string, string> | (() => Record<string, string>)
  /**
   * Fields to deep-merge into the serialized body, route-wide. The caller's
   * value always wins, even over a field the SDK set (`model`, `max_tokens`,
   * `reasoning`, `stream`, …) — decision 12. A `null` value deletes the field.
   */
  body?: Readonly<Record<string, unknown>>
  /**
   * Last-resort hook with full authority over the body, run after `body` is
   * merged in and right before the request is sent (and logged). Prefer
   * `body` when a deep-merge already says what you mean.
   */
  transformRequest?: (body: unknown, ctx: RequestContext) => unknown
  /**
   * Advisory model catalog.
   *
   * Requests are never restricted to it. Supply entries to declare capabilities
   * the SDK cannot infer — most importantly image support, since an uncatalogued
   * model is treated as text-only and its images are projected to text.
   */
  models?: readonly ProviderCatalogModel[]
  /**
   * Fetch the catalog from the endpoint instead of declaring it.
   *
   * Result is memoized for {@link catalogTtlMs}. A failure here is NOT fatal:
   * refusing the actual model call because a metadata request failed would be the
   * wrong trade.
   */
  discoverModels?: (context: ModelDiscoveryContext) => Promise<readonly ProviderCatalogModel[]>
  /** How long a discovered catalog is reused. Defaults to five minutes. */
  catalogTtlMs?: number
  /** Additional opt-in lifetime for the last valid catalog after refresh failure. */
  catalogStaleTtlMs?: number
  /** Backoff after discovery failure before another refresh is attempted. */
  catalogFailureBackoffMs?: number
  /** Maximum catalog entries retained from static config or discovery. Defaults to 2,048. */
  maxCatalogModels?: number
  /** Maximum serialized catalog bytes retained. Defaults to 4 MiB. */
  maxCatalogBytes?: number
  /**
   * Decorate resolved model metadata.
   *
   * The hook for capabilities that come from the endpoint's configuration rather
   * than its catalog — Anthropic uses it to advertise thinking budgets as
   * selectable reasoning efforts.
   */
  describeModel?: (info: ResolvedModelInfo, dialect: Dialect) => ResolvedModelInfo
  /** Output cap when neither caller nor catalog names one. */
  defaultMaxTokens?: number
  /** Context capacity assumed for an uncatalogued model. */
  defaultContextWindow?: number
  /** Idle bound while a stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** End-to-end request/stream timeout. Defaults to ten minutes. */
  requestTimeoutMs?: number
  /** Maximum serialized outbound request bytes. Defaults to 32 MiB. */
  maxRequestBytes?: number
  /** Maximum cumulative successful response bytes. Defaults to 32 MiB. */
  maxResponseBytes?: number
  /** Maximum raw response chunks. Defaults to 100,000. */
  maxResponseChunks?: number
  /** Maximum decoded SSE events accepted from one response. */
  maxSseEvents?: number
  /** Maximum characters accepted in one decoded SSE event. */
  maxSseEventChars?: number
  /** Maximum non-success response bytes retained. Defaults to 1 MiB. */
  maxErrorBodyBytes?: number
  /** Maximum time granted to the optional request logger. Defaults to 5 seconds. */
  requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  retryPolicy?: RetryPolicyConfig
  /**
   * Classify a status this endpoint reports specially.
   *
   * Return `undefined` to fall through to the shared mapping, so an override only
   * has to describe what is genuinely different.
   */
  errorCode?: (status: number, detail: string) => string | undefined
  /** Override the `accept` / `content-type` the pipeline sends. */
  baseHeaders?: Record<string, string>
  /**
   * Observe exact protocol-serialized requests immediately before `fetch`.
   * Credentials are redacted, but bodies still contain prompts and tool output.
   * @deprecated High-risk compatibility bridge. Prefer structured observation.
   */
  requestLogger?: ProviderRequestLogger
  /**
   * Observe the exact, header-redacted wire response once a stream ends.
   * `frames` is every decoded SSE event in this provider's own vocabulary,
   * before `translate()` reshapes it — the counterpart `requestLogger` is
   * missing entirely, and without it a trace can show what went out but not
   * what came back.
   */
  responseLogger?: ProviderResponseLogger
}

const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1_000
const DEFAULT_CATALOG_STALE_TTL_MS = 0
const DEFAULT_CATALOG_FAILURE_BACKOFF_MS = 5_000
const DEFAULT_MAX_CATALOG_MODELS = 2_048
const DEFAULT_MAX_CATALOG_BYTES = 4 * 1024 * 1024

/** Resolve one credential source, with a useful label on failure. */
async function credential(
  source: CredentialSource,
  displayName: string,
  label: string,
  signal?: AbortSignal,
  context?: ModelInvocationContext,
): Promise<string> {
  const value = typeof source === 'function' ? await source(signal, context) : source
  return assertUsableApiKey(value, displayName, label)
}

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
  private catalog: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined
  private catalogFailureAt: number | undefined

  constructor(options: HttpProviderOptions<Dialect>) {
    super()
    const maxCatalogModels = positiveSafeInteger(
      options.maxCatalogModels ?? DEFAULT_MAX_CATALOG_MODELS,
      'maxCatalogModels',
    )
    const maxCatalogBytes = positiveSafeInteger(
      options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
      'maxCatalogBytes',
    )
    const models = options.models === undefined
      ? undefined
      : boundedCatalog(options.models, maxCatalogModels, maxCatalogBytes)
    this.options = Object.freeze({
      ...options,
      catalogTtlMs: positiveFinite(options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS, 'catalogTtlMs'),
      catalogStaleTtlMs: nonNegativeFinite(
        options.catalogStaleTtlMs ?? DEFAULT_CATALOG_STALE_TTL_MS,
        'catalogStaleTtlMs',
      ),
      catalogFailureBackoffMs: nonNegativeFinite(
        options.catalogFailureBackoffMs ?? DEFAULT_CATALOG_FAILURE_BACKOFF_MS,
        'catalogFailureBackoffMs',
      ),
      maxCatalogModels,
      maxCatalogBytes,
      auth: Object.freeze(authSchemesOf(options.auth).map(scheme => Object.freeze({ ...scheme }))),
      ...(models === undefined ? {} : { models }),
      ...(options.headers === undefined || typeof options.headers === 'function'
        ? {}
        : { headers: Object.freeze({ ...options.headers }) }),
      ...(options.baseHeaders === undefined ? {} : { baseHeaders: Object.freeze({ ...options.baseHeaders }) }),
      ...(options.query === undefined || typeof options.query === 'function'
        ? {}
        : { query: Object.freeze({ ...options.query }) }),
      ...(options.body === undefined ? {} : { body: Object.freeze({ ...options.body }) }),
    })
    this.displayName = options.displayName
    this.dialect = resolveDialect(options.protocol, options.dialect)
    this.retry = resolveRetryPolicy(options.retryPolicy, `${options.displayName}.retryPolicy`)
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
    if (this.catalogFailureAt !== undefined) {
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

  /** Resolve one scheme for one operation, as either a header or a query param. */
  private async authSchemeResolved(
    auth: AuthScheme,
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<{ headers: Readonly<Record<string, string>>; query: Readonly<Record<string, string>> }> {
    switch (auth.kind) {
      case 'none':
        return { headers: {}, query: {} }
      case 'bearer': {
        const token = await observeCredentialOperation(context, provider, 'resolve', () => credential(
          auth.token, this.displayName, auth.label ?? 'the `auth.token` option', signal, context,
        ))
        return { headers: { authorization: `Bearer ${token}` }, query: {} }
      }
      case 'header': {
        const value = await observeCredentialOperation(context, provider, 'resolve', () => credential(
          auth.value, this.displayName, auth.label ?? `the \`${auth.name}\` credential`, signal, context,
        ))
        return { headers: { [auth.name]: value }, query: {} }
      }
      case 'query': {
        const value = await observeCredentialOperation(context, provider, 'resolve', () => credential(
          auth.value, this.displayName, auth.label ?? `the \`${auth.name}\` query credential`, signal, context,
        ))
        return { headers: {}, query: { [auth.name]: value } }
      }
      case 'dynamic':
        return {
          headers: await observeCredentialOperation(
            context, provider, 'resolve', async () => await auth.resolve(signal, context, provider),
          ),
          query: {},
        }
      default:
        return { headers: {}, query: {} }
    }
  }

  /**
   * Resolve every configured scheme in parallel and union their headers and
   * query params.
   *
   * Two schemes producing the same header name (or the same query param name)
   * fail fast, before the merged result ever reaches {@link mergeHeaderLayers}
   * — a collision here is a configuration mistake (the same credential
   * declared twice, or two schemes racing for `authorization`), not something
   * a later-layer-wins policy should paper over.
   */
  private async authHeaders(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<ResolvedAuth> {
    const schemes = authSchemesOf(this.options.auth)
    const resolved = await Promise.all(
      schemes.map(scheme => this.authSchemeResolved(scheme, provider, signal, context)),
    )
    const headers = unionByName(resolved.map(entry => entry.headers), 'header')
    const query = unionByName(resolved.map(entry => entry.query), 'query param')
    return { headers, query }
  }

  protected override async connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
    model?: string,
  ): Promise<HttpConnection> {
    const timeoutMs = positiveFinite(
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    )
    const timeout = AbortSignal.timeout(timeoutMs)
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '')
    // Credential and endpoint resolve together, in one snapshot, so a rotating
    // secret can never be paired with a different generation's URL.
    const extra = typeof this.options.headers === 'function'
      ? this.options.headers({
        provider,
        ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(operationSignal === undefined ? {} : { signal: operationSignal }),
      })
      : this.options.headers ?? {}
    const modelEntry = model === undefined
      ? undefined
      : this.options.models?.find(candidate => candidate.id === model)
    const publicLayers = [
      captureHeaderLayer({
        layer: 'transport', headers: this.options.baseHeaders ?? DEFAULT_TRANSPORT_HEADERS,
      }),
      captureHeaderLayer({ layer: 'sdk-attribution', headers: attributionHeaders() }),
      captureHeaderLayer({
        layer: 'wire-protocol',
        headers: this.options.protocol.protocolHeaders?.(this.dialect) ?? {},
      }),
      captureHeaderLayer({ layer: 'endpoint', headers: extra }),
      // The model's own headers win over the route's, per decision 12's
      // "route, model, agent" precedence.
      captureHeaderLayer({ layer: 'endpoint', headers: modelEntry?.headers ?? {} }),
      // The agent's own headers, last among the public layers so they win over
      // both the route's and the model's.
      captureHeaderLayer({ layer: 'endpoint', headers: context?.providerOptions?.headers ?? {} }),
    ] as const
    // Structural conflicts that do not depend on credentials fail before secret
    // resolution. The captured layer snapshots cannot mutate while auth awaits.
    mergeHeaderLayers(publicLayers)
    const auth = await raceAbort(this.authHeaders(provider, operationSignal, context), operationSignal)
    const merged = mergeHeaderLayers([
      ...publicLayers,
      captureHeaderLayer({ layer: 'auth', headers: auth.headers }),
    ])
    const headers = merged.headers

    return {
      baseUrl,
      headers,
      sensitiveHeaderNames: merged.sensitiveHeaderNames,
      ...(Object.keys(auth.query).length === 0 ? {} : {
        queryOverrides: auth.query,
        sensitiveQueryParamNames: Object.freeze(Object.keys(auth.query)),
      }),
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRequestBytes: this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxResponseChunks: this.options.maxResponseChunks ?? DEFAULT_MAX_RESPONSE_CHUNKS,
      ...(this.options.maxSseEvents === undefined ? {} : { maxSseEvents: this.options.maxSseEvents }),
      ...(this.options.maxSseEventChars === undefined
        ? {}
        : { maxSseEventChars: this.options.maxSseEventChars }),
      maxErrorBodyBytes: this.options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
      ...this.options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: this.options.allowInsecureHttp },
      ...this.options.fetch === undefined ? {} : { fetch: this.options.fetch },
      ...this.options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: this.options.requestLoggerTimeoutMs },
      retryPolicy: this.retry,
      models: this.options.models ?? await this.resolveCatalog(
        provider, baseUrl, headers, operationSignal, context,
      ),
      ...(this.options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: this.options.defaultMaxTokens }),
      ...(this.options.defaultContextWindow === undefined ? {} : { defaultContextWindow: this.options.defaultContextWindow }),
    }
  }

  /** Run the discovery hook, memoized, tolerating failure. */
  private async resolveCatalog(
    provider: string,
    baseUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<readonly ProviderCatalogModel[]> {
    const discover = this.options.discoverModels
    if (discover === undefined) return []
    const ttl = this.options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
    const staleTtl = this.options.catalogStaleTtlMs ?? DEFAULT_CATALOG_STALE_TTL_MS
    const failureBackoff = this.options.catalogFailureBackoffMs
      ?? DEFAULT_CATALOG_FAILURE_BACKOFF_MS
    const now = Date.now()
    const cached = this.catalog
    if (cached !== undefined && now - cached.fetchedAt < ttl) return cached.models
    if (this.catalogFailureAt !== undefined && now - this.catalogFailureAt < failureBackoff) {
      return staleCatalog(cached, now, ttl, staleTtl)
    }

    try {
      const discovered = await observeModelCatalogOperation(
        context,
        provider,
        new URL(baseUrl).origin,
        async () => {
          const pending = discover({
            baseUrl,
            headers,
            provider,
            ...(context === undefined ? {} : { context }),
            ...signal === undefined ? {} : { signal },
          })
          return signal === undefined ? await pending : await raceAbort(pending, signal)
        },
      )
      const models = boundedCatalog(
        discovered,
        this.options.maxCatalogModels ?? DEFAULT_MAX_CATALOG_MODELS,
        this.options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
      )
      this.catalog = { models, fetchedAt: Date.now() }
      this.catalogFailureAt = undefined
      return models
    } catch (error: unknown) {
      // Cancellation belongs to the caller/runtime refresh generation. Treating
      // it as an offline empty catalog would publish a false successful result.
      if (signal?.aborted === true) throw signal.reason ?? error
      // Offline, unauthorized for metadata, or transient. An empty catalog only
      // costs capability detail; failing the call would cost the whole request.
      this.catalogFailureAt = Date.now()
      return staleCatalog(cached, this.catalogFailureAt, ttl, staleTtl)
    }
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

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`)
  }
  return value
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`)
  }
  return value
}

function staleCatalog(
  cached: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined,
  now: number,
  ttl: number,
  staleTtl: number,
): readonly ProviderCatalogModel[] {
  if (cached === undefined || now - cached.fetchedAt >= ttl + staleTtl) return []
  return cached.models
}

/** Validate resource bounds before retaining a provider-controlled catalog. */
function boundedCatalog(
  value: readonly ProviderCatalogModel[],
  maxModels: number,
  maxBytes: number,
): readonly ProviderCatalogModel[] {
  if (!Array.isArray(value)) throw new TypeError('model catalog must be an array')
  if (value.length > maxModels) {
    throw new RangeError(`model catalog exceeds maxCatalogModels (${maxModels})`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new TypeError('model catalog must be JSON-serializable', { cause: error })
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new RangeError(`model catalog exceeds maxCatalogBytes (${maxBytes})`)
  }
  return detachedFrozen(value)
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('HTTP provider operation aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('HTTP provider operation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

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
