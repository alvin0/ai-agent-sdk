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
 *   auth: { kind: 'bearer', token: apiKeyFromEnv('OPENROUTER_API_KEY') },
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

import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { resolveRetryPolicy, type RetryPolicyConfig } from '@ai-agent-sdk/core'
import type { ResolvedRetryPolicy } from '@ai-agent-sdk/core'
import { assertUsableApiKey } from '@ai-agent-sdk/core'
import { attributionHeaders } from '@ai-agent-sdk/core'
import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@ai-agent-sdk/core'
import { detachedFrozen } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import type { SseEvent } from '../core/stream/sse.ts'
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
} from './base/http-adapter.ts'
import { resolveDialect, type WireProtocol } from './protocols/protocol.ts'

/** A credential, either literal or resolved per operation. */
export type CredentialSource = string | ((signal?: AbortSignal) => string | Promise<string>)

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
    resolve: (signal?: AbortSignal) => Record<string, string> | Promise<Record<string, string>>
  }

/**
 * Read a credential from the environment, failing with the variable's name.
 *
 * Named rather than implicit so the diagnostic can say WHICH variable to set,
 * which is the only thing the reader of that error needs.
 * @param envVar - the variable to read.
 * @returns a credential source.
 */
export function apiKeyFromEnv(envVar: string): () => string {
  return () => {
    const value = globalThis.process?.env?.[envVar]
    if (value === undefined || value.length === 0) {
      throw new AgentSdkError(
        `no credential available; set ${envVar}`,
        MISSING_CREDENTIAL_CODE,
      )
    }
    return value
  }
}

/** What a model-discovery hook receives. */
export interface ModelDiscoveryContext {
  /** The endpoint base, with no trailing slash. */
  readonly baseUrl: string
  /** Every header the request would carry, including authentication. */
  readonly headers: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** Configuration for {@link createHttpProvider}. */
export interface HttpProviderOptions<Dialect extends object> {
  /** Human-readable name used in every diagnostic. */
  displayName: string
  /** The wire protocol this endpoint speaks. */
  protocol: WireProtocol<Dialect>
  /** Endpoint base; the protocol's path is appended. */
  baseUrl: string
  /** How to authenticate. */
  auth: AuthScheme
  /**
   * Per-endpoint protocol knobs, merged over the protocol's defaults.
   *
   * Partial, so a protocol can gain a knob without any endpoint needing an edit.
   */
  dialect?: Partial<Dialect>
  /** Extra static headers, or a resolver for them. */
  headers?: Record<string, string> | (() => Record<string, string>)
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
   */
  requestLogger?: ProviderRequestLogger
}

const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1_000
const DEFAULT_MAX_CATALOG_MODELS = 2_048
const DEFAULT_MAX_CATALOG_BYTES = 4 * 1024 * 1024

/** Resolve one credential source, with a useful label on failure. */
async function credential(
  source: CredentialSource,
  displayName: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = typeof source === 'function' ? await source(signal) : source
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
      maxCatalogModels,
      maxCatalogBytes,
      auth: Object.freeze({ ...options.auth }),
      ...(models === undefined ? {} : { models }),
      ...(options.headers === undefined || typeof options.headers === 'function'
        ? {}
        : { headers: Object.freeze({ ...options.headers }) }),
      ...(options.baseHeaders === undefined ? {} : { baseHeaders: Object.freeze({ ...options.baseHeaders }) }),
    })
    this.displayName = options.displayName
    this.dialect = resolveDialect(options.protocol, options.dialect)
    this.retry = resolveRetryPolicy(options.retryPolicy, `${options.displayName}.retryPolicy`)
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.retry
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    const base = await super.resolveModel(provider, model, signal)
    return this.options.describeModel?.(base, this.dialect) ?? base
  }

  /** Resolve the authentication headers for one operation. */
  private async authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const auth = this.options.auth
    switch (auth.kind) {
      case 'none':
        return {}
      case 'bearer': {
        const token = await credential(
          auth.token,
          this.displayName,
          auth.label ?? 'the `auth.token` option',
          signal,
        )
        return { authorization: `Bearer ${token}` }
      }
      case 'header': {
        const value = await credential(
          auth.value,
          this.displayName,
          auth.label ?? `the \`${auth.name}\` credential`,
          signal,
        )
        return { [auth.name]: value }
      }
      case 'dynamic':
        return await auth.resolve(signal)
      default:
        return {}
    }
  }

  protected override async connect(
    _provider: string,
    signal?: AbortSignal,
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
      ? this.options.headers()
      : this.options.headers ?? {}
    const headers: Record<string, string> = {
      ...attributionHeaders(),
      ...this.options.protocol.protocolHeaders?.(this.dialect) ?? {},
      ...extra,
      ...await raceAbort(this.authHeaders(operationSignal), operationSignal),
    }

    return {
      baseUrl,
      headers,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRequestBytes: this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxResponseChunks: this.options.maxResponseChunks ?? DEFAULT_MAX_RESPONSE_CHUNKS,
      maxErrorBodyBytes: this.options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
      ...this.options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: this.options.requestLoggerTimeoutMs },
      retryPolicy: this.retry,
      models: this.options.models ?? await this.resolveCatalog(baseUrl, headers, operationSignal),
      defaultMaxTokens: this.options.defaultMaxTokens ?? 8_192,
      defaultContextWindow: this.options.defaultContextWindow ?? 128_000,
    }
  }

  /** Run the discovery hook, memoized, tolerating failure. */
  private async resolveCatalog(
    baseUrl: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<readonly ProviderCatalogModel[]> {
    const discover = this.options.discoverModels
    if (discover === undefined) return []
    const ttl = this.options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
    const cached = this.catalog
    if (cached !== undefined && Date.now() - cached.fetchedAt < ttl) return cached.models

    let models: readonly ProviderCatalogModel[] = []
    try {
      const pending = discover({
        baseUrl,
        headers,
        ...signal === undefined ? {} : { signal },
      })
      const discovered = signal === undefined ? await pending : await raceAbort(pending, signal)
      models = boundedCatalog(
        discovered,
        this.options.maxCatalogModels ?? DEFAULT_MAX_CATALOG_MODELS,
        this.options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
      )
    } catch {
      // Offline, unauthorized for metadata, or transient. An empty catalog only
      // costs capability detail; failing the call would cost the whole request.
    }
    this.catalog = { models, fetchedAt: Date.now() }
    return models
  }

  protected override baseHeaders(): Record<string, string> {
    return this.options.baseHeaders ?? super.baseHeaders()
  }

  protected override observeRequest(record: ProviderRequestLogRecord): Promise<void> | void {
    return this.options.requestLogger?.(record)
  }

  protected override providerErrorCode(status: number, detail: string): string {
    return this.options.errorCode?.(status, detail) ?? super.providerErrorCode(status, detail)
  }

  protected override endpointPath(request: ProviderRequest): string {
    return this.options.protocol.endpointPath(request, this.dialect)
  }

  protected override buildBody(request: ProviderRequest): unknown | Promise<unknown> {
    return this.options.protocol.serialize(request, this.dialect)
  }

  protected override translate(
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
  ): AsyncGenerator<StreamChunk> {
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
