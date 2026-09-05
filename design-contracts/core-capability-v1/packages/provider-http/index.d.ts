import {
  ModelAdapter,
  type CredentialInput,
  type GenerateOptions,
  type ModelInfo,
  type ModelModality,
  type ModelReasoningInfo,
  ModelInvocationContext,
  NativeToolName,
  type PreparedAdapterCall,
  type ProviderInfo,
  type ProviderRequestId,
  ResolvedModelInfo,
  type ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
  UsageCounters,
} from '@ai-agent-sdk/core/provider'

export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
export declare const DEFAULT_REQUEST_TIMEOUT_MS: number
export declare const DEFAULT_MAX_REQUEST_BYTES: number
export declare const DEFAULT_MAX_RESPONSE_BYTES: number
export declare const DEFAULT_MAX_RESPONSE_CHUNKS = 100000
export declare const DEFAULT_MAX_ERROR_BODY_BYTES: number
export declare const DEFAULT_REQUEST_LOGGER_TIMEOUT_MS = 5000

export interface SseEvent {
  event: string | undefined
  data: string
}

export declare function parseSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  teardownTimeoutMs?: number,
): AsyncGenerator<SseEvent>

export declare const HTTP_PROTOCOL_API_VERSION: 1
export declare const HTTP_PROVIDER_ERROR_CODES: {
  readonly PROTOCOL_API_UNSUPPORTED: 'HTTP_PROTOCOL_API_UNSUPPORTED'
  readonly HEADER_INVALID: 'HTTP_HEADER_INVALID'
  readonly HEADER_RESERVED: 'HTTP_HEADER_RESERVED'
  readonly HEADER_COLLISION: 'HTTP_HEADER_COLLISION'
  readonly WIRE_BODY_INVALID: 'HTTP_WIRE_BODY_INVALID'
  readonly WIRE_BODY_TOO_LARGE: 'HTTP_WIRE_BODY_TOO_LARGE'
  readonly STREAM_MEDIA_TYPE_INVALID: 'HTTP_STREAM_MEDIA_TYPE_INVALID'
  readonly SSE_LIMIT_EXCEEDED: 'HTTP_SSE_LIMIT_EXCEEDED'
}
export type CredentialSource = string | ((
  signal?: AbortSignal,
  context?: ModelInvocationContext,
) => string | Promise<string>)
export type RuntimeCredentialSource = CredentialInput

export interface ProtocolSseEvent {
  readonly event: string | undefined
  readonly data: string
}

export type ProtocolStreamChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }

export interface HttpConnection {
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly streamIdleTimeoutMs: number
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  readonly allowInsecureHttp?: boolean
  readonly retryPolicy: ResolvedRetryPolicy
  readonly models: readonly ProviderCatalogModel[]
  readonly defaultMaxTokens: number
  readonly defaultContextWindow: number
}

export interface ProviderRequest {
  readonly options: GenerateOptions
  readonly model: ResolvedModelInfo
  readonly connection: HttpConnection
  readonly maxTokens: number
}

export type WireProtocolChunk = ProtocolStreamChunk
export type AnyWireProtocol = WireProtocol<never>

/** Existing marker-free extension protocol. */
export interface WireProtocol<Dialect> {
  readonly id: string
  readonly defaultDialect: Dialect
  endpointPath(request: ProviderRequest, dialect: Dialect): string
  protocolHeaders?(dialect: Dialect): Record<string, string>
  serialize(request: ProviderRequest, dialect: Dialect): unknown | Promise<unknown>
  translate(
    events: AsyncIterable<SseEvent>,
    request: ProviderRequest,
    displayName: string,
  ): AsyncGenerator<WireProtocolChunk>
}

export interface ProtocolRequest {
  readonly options: GenerateOptions
  readonly model: ResolvedModelInfo
  readonly connection: HttpConnection
  readonly maxTokens: number
}

/**
 * A provider protocol returns one JSON object. Nested values stay structurally
 * open for provider extensions, but createHttpProvider validates, bounds, and
 * deep-detaches the complete graph before encoding or dispatch.
 */
export type ProtocolJsonObject = Readonly<Record<string, unknown>>

export interface RuntimeWireProtocol<Dialect extends object> {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: typeof HTTP_PROTOCOL_API_VERSION
  readonly id: string
  readonly defaultDialect: Dialect
  readonly endpointPath: (request: ProtocolRequest, dialect: Dialect) => string
  readonly protocolHeaders?: (dialect: Dialect) => Readonly<Record<string, string>>
  readonly serialize: (
    request: ProtocolRequest,
    dialect: Dialect,
  ) => ProtocolJsonObject
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

export type WireProtocolDefinition<Dialect extends object> = Omit<
  RuntimeWireProtocol<Dialect>,
  'kind' | 'apiVersion'
>

export declare function defineWireProtocol<Dialect extends object>(
  definition: WireProtocolDefinition<Dialect>,
): RuntimeWireProtocol<Dialect>

export interface HttpAuthResolveOptions {
  readonly provider: string
  readonly baseUrl: URL
  readonly signal: AbortSignal
  readonly context?: ModelInvocationContext
}

export type RuntimeAuthScheme =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: RuntimeCredentialSource; readonly label?: string }
  | {
    readonly kind: 'header'
    readonly name: string
    readonly value: RuntimeCredentialSource
    readonly label?: string
  }
  | {
    readonly kind: 'dynamic'
    readonly resolve: (
      options: HttpAuthResolveOptions,
    ) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>
  }

export type AuthScheme =
  | { kind: 'none' }
  | { kind: 'bearer'; token: CredentialSource; label?: string }
  | { kind: 'header'; name: string; value: CredentialSource; label?: string }
  | {
    kind: 'dynamic'
    resolve: (
      signal?: AbortSignal,
      context?: ModelInvocationContext,
    ) => Record<string, string> | Promise<Record<string, string>>
  }

export interface ProviderCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly ModelModality[]
  outputModalities?: readonly ModelModality[]
  nativeTools?: readonly NativeToolName[]
  reasoning?: ModelReasoningInfo
}

export interface RuntimeModelDiscoveryContext {
  readonly provider: string
  readonly baseUrl: URL
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly context?: ModelInvocationContext
}

export interface ModelDiscoveryContext {
  readonly baseUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export interface ProviderRequestLogRecord {
  readonly schemaVersion: 1
  readonly type: 'provider-request'
  readonly id: string
  readonly timestamp: string
  readonly provider: string
  readonly model: string
  readonly method: 'POST'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
  readonly bodyBytes: number
}

export type ProviderRequestLogger = (
  record: ProviderRequestLogRecord,
) => void | Promise<void>

export declare abstract class HttpModelAdapter extends ModelAdapter {
  protected abstract readonly displayName: string
  protected abstract connect(provider: string, signal?: AbortSignal, context?: ModelInvocationContext): Promise<HttpConnection>
  protected abstract endpointPath(request: ProviderRequest): string
  protected abstract buildBody(request: ProviderRequest): unknown | Promise<unknown>
  protected abstract translate(events: AsyncIterable<SseEvent>, request: ProviderRequest): AsyncGenerator<WireProtocolChunk>
  protected baseHeaders(): Record<string, string>
  protected observeRequest(record: ProviderRequestLogRecord): Promise<void> | void
  protected providerErrorCode(status: number, detail: string): string
  providerInfo(provider: string): ProviderInfo
  listModels(provider: string): Promise<readonly ModelInfo[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo>
  prepareCall(provider: string, model: string, signal?: AbortSignal, context?: ModelInvocationContext): Promise<PreparedAdapterCall>
  stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk>
}

export declare function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string>
export declare function httpErrorCode(status: number, detail?: string): string
export declare function retryAfterMs(value: string | null): number | undefined
export declare function requestIdFrom(headers: Headers): ProviderRequestId | undefined
export interface ParsedErrorBody { message: string | undefined; detail: string }
export declare function parseErrorBody(raw: string): ParsedErrorBody
export declare function resolveDialect<Dialect extends object>(protocol: WireProtocol<Dialect>, overrides: Partial<Dialect> | undefined): Dialect
export declare function observeCredentialOperation<T>(context: ModelInvocationContext | undefined, provider: string, operation: 'resolve' | 'refresh' | 'login', task: () => Promise<T>): Promise<T>
export declare function observeModelCatalogOperation<T>(context: ModelInvocationContext | undefined, provider: string, origin: string, task: () => Promise<T>): Promise<T>

export interface RuntimeHttpProviderOptions<Dialect extends object> {
  readonly displayName: string
  readonly protocol: RuntimeWireProtocol<Dialect>
  readonly baseUrl: string | URL
  readonly allowInsecureHttp?: boolean
  readonly auth: RuntimeAuthScheme
  readonly models?: readonly ProviderCatalogModel[]
  readonly dialect?: Partial<Dialect>
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  readonly discoverModels?: (
    context: RuntimeModelDiscoveryContext,
  ) => Promise<readonly ProviderCatalogModel[]>
  readonly catalogTtlMs?: number
  readonly catalogStaleTtlMs?: number
  readonly catalogFailureBackoffMs?: number
  readonly maxCatalogModels?: number
  readonly maxCatalogBytes?: number
  readonly describeModel?: (info: ResolvedModelInfo, dialect: Dialect) => ResolvedModelInfo
  readonly defaultMaxTokens?: number
  readonly defaultContextWindow?: number
  readonly streamIdleTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxSseEvents?: number
  readonly maxSseEventChars?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  readonly retryPolicy?: RetryPolicyConfig
  readonly errorCode?: (status: number, detail: string) => string | undefined
  readonly baseHeaders?: Readonly<Record<string, string>>
  readonly requestLogger?: ProviderRequestLogger
}

export interface HttpProviderOptions<Dialect extends object> {
  displayName: string
  protocol: WireProtocol<Dialect>
  baseUrl: string
  allowInsecureHttp?: boolean
  auth: AuthScheme
  models?: readonly ProviderCatalogModel[]
  dialect?: Partial<Dialect>
  fetch?: typeof globalThis.fetch
  headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>>)
  discoverModels?: (
    context: ModelDiscoveryContext,
  ) => Promise<readonly ProviderCatalogModel[]>
  catalogTtlMs?: number
  catalogStaleTtlMs?: number
  catalogFailureBackoffMs?: number
  maxCatalogModels?: number
  maxCatalogBytes?: number
  describeModel?: (
    info: ResolvedModelInfo,
    dialect: Dialect,
  ) => ResolvedModelInfo
  defaultMaxTokens?: number
  defaultContextWindow?: number
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  errorCode?: (status: number, detail: string) => string | undefined
  baseHeaders?: Readonly<Record<string, string>>
  /** High-risk exact-body bridge; only credential headers are redacted. */
  requestLogger?: ProviderRequestLogger
}

export declare function createRuntimeHttpProvider<Dialect extends object>(
  options: RuntimeHttpProviderOptions<Dialect>,
): HttpModelAdapter
export declare function createHttpProvider<Dialect extends object>(
  options: HttpProviderOptions<Dialect>,
): HttpModelAdapter
