import type { SupportSafeError } from '@ai-agent-sdk/core/agent'
import type {
  JsonObject,
  JsonValue,
  ToolCatalog,
  ToolCatalogSnapshot,
  ToolFilter,
  ToolSource,
  ToolSourceSnapshotOptions,
  SdkLogger,
} from '@ai-agent-sdk/core/tools'

export type McpVersionNegotiationMode = 'legacy' | 'auto' | { readonly pin: string }

export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface McpStreamableHttpTransportOptions {
  readonly authProvider?: object
  readonly skipIssuerMetadataValidation?: boolean
  readonly requestInit?: RequestInit
  readonly fetch?: McpFetch
  readonly reconnectionOptions?: {
    readonly maxReconnectionDelay: number
    readonly initialReconnectionDelay: number
    readonly reconnectionDelayGrowFactor: number
    readonly maxRetries: number
  }
  readonly reconnectionScheduler?: (
    reconnect: () => void,
    delay: number,
    attemptCount: number,
  ) => (() => void) | void
  readonly sessionId?: string
  readonly protocolVersion?: string
  readonly onInsufficientScope?: 'reauthorize' | 'throw'
  readonly maxStepUpRetries?: number
}

export interface McpSseTransportOptions {
  readonly authProvider?: object
  readonly skipIssuerMetadataValidation?: boolean
  readonly eventSourceInit?: { readonly fetch?: McpFetch }
  readonly requestInit?: RequestInit
  readonly fetch?: McpFetch
}

export interface McpTransport {
  start(): Promise<void>
  send(...args: never[]): Promise<void>
  close(): Promise<void>
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
}

export interface McpCallToolResult {
  readonly [key: string]: unknown
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean | undefined
}

export interface McpProtocolClient {
  callTool(
    params: { readonly name: string; readonly arguments?: JsonObject },
    options?: { readonly signal?: AbortSignal; readonly timeout?: number },
  ): Promise<McpCallToolResult>
  listTools(params?: JsonObject, options?: object): Promise<JsonObject>
  listResources(params?: JsonObject, options?: object): Promise<JsonObject>
  readResource(params: { readonly uri: string }, options?: object): Promise<JsonObject>
  listPrompts(params?: JsonObject, options?: object): Promise<JsonObject>
  getPrompt(params: { readonly name: string; readonly arguments?: JsonObject }, options?: object): Promise<JsonObject>
  ping(options?: object): Promise<JsonObject>
  close(): Promise<void>
}

export interface McpReconnectOptions {
  readonly enabled?: boolean
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxAttempts?: number
}

export interface ResolvedMcpReconnectOptions {
  readonly enabled: boolean
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

export type McpClientStatus =
  | 'idle'
  | 'connecting'
  /** @deprecated Observe the more specific authentication statuses instead. */
  | 'authorization-required'
  | 'authentication-required'
  | 'authentication-failed'
  | 'oauth-authorization-required'
  | 'scope-authorization-required'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'closed'

export type McpAuthenticationKind = 'none' | 'bearer' | 'oauth' | 'unknown'
export type McpTransportKind = 'streamable-http' | 'sse' | 'custom'

export interface McpAuthorizationState {
  readonly kind: McpAuthenticationKind
  readonly reason:
    | 'credentials-required'
    | 'invalid-credentials'
    | 'authorization-code-required'
    | 'insufficient-scope'
  readonly requiredScope?: string
}

export interface McpProtocolState {
  readonly era: 'modern' | 'legacy'
  readonly version?: string
  readonly transport: McpTransportKind
  readonly fallback: boolean
}

export interface McpClientState {
  readonly status: McpClientStatus
  readonly serverName: string
  readonly attempt: number
  /** Current advanced field; never serialize it as support-safe data. */
  readonly error?: Error
  readonly authorization?: McpAuthorizationState
  readonly protocol?: McpProtocolState
  /** Additive runtime snapshot identity. */
  readonly catalogRevision: number
  /** Separately projected bounded diagnostic form. */
  readonly supportError?: SupportSafeError
}

export interface McpClientLifecycleOptions {
  readonly serverName: string
  readonly logger?: SdkLogger
  readonly clientName?: string
  readonly clientVersion?: string
  readonly protocol?: McpVersionNegotiationMode
  readonly reconnect?: McpReconnectOptions | false
  readonly toolFilter?: ToolFilter
  readonly prefixToolNames?: boolean
  readonly toolCallTimeoutMs?: number
  readonly operationTimeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly maxTools?: number
  readonly maxCatalogBytes?: number
  readonly maxToolResultBytes?: number
  readonly trustReadOnlyAnnotations?: boolean
  readonly onStateChange?: (state: McpClientState) => void
  readonly signal?: AbortSignal
}

export interface McpHttpClientOptions extends McpClientLifecycleOptions {
  readonly url: string | URL
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: RequestInit['headers']
  readonly allowedOrigins?: readonly string[]
  readonly requireHttps?: boolean
  readonly allowPrivateNetwork?: boolean
  readonly allowRedirects?: boolean
  readonly validateEndpoint?: (url: URL) => void
  readonly maxTransportBytes?: number
  readonly transport?: Omit<McpStreamableHttpTransportOptions, 'requestInit'> & {
    readonly requestInit?: RequestInit
  }
  readonly legacySse?: false | {
    readonly url?: string | URL
    readonly transport?: McpSseTransportOptions
  }
}

export type McpToolResultValue = JsonObject & {
  readonly content: readonly JsonValue[]
  readonly structuredContent?: JsonValue
}

export type McpTransportFactory = () => McpTransport

export interface McpClientRuntimeOptions {
  readonly authenticationKind?: McpAuthenticationKind
  readonly fallbackTransportFactory?: McpTransportFactory
}

export interface McpOAuthCallbackOptions {
  readonly expectedState: string
  readonly signal?: AbortSignal
}

export interface McpCloseReport {
  readonly state: 'closed'
  readonly deadlineReached: boolean
  readonly unsettledOperations: number
  readonly error?: SupportSafeError
}

export declare class McpConnectionError extends Error {
  readonly code: 'MCP_CONNECT_FAILED'
  readonly stage: 'transport' | 'authentication' | 'handshake' | 'catalog' | 'unknown'
  readonly failure: SupportSafeError
  /** Failed-connect rollback evidence; never replaces the primary failure. */
  readonly cleanup: McpCloseReport
}

/**
 * One caller-owned connection. Existing advanced methods stay intact; the
 * ToolSource fields provide the additive composition view on the same object.
 */
export declare class McpClientConnection implements ToolSource {
  readonly kind: 'tool-source'
  readonly apiVersion: 1
  readonly id: string
  readonly serverName: string
  /** Compatibility view for direct callers; core composition uses snapshot(). */
  readonly tools: ToolCatalog
  constructor(
    options: McpClientLifecycleOptions,
    transportFactory: McpTransportFactory,
    runtime?: McpClientRuntimeOptions,
  )
  get state(): McpClientState
  snapshot(options: ToolSourceSnapshotOptions): ToolCatalogSnapshot
  withClient<T>(
    operation: (client: McpProtocolClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  connect(): Promise<void>
  refreshTools(options?: { readonly signal?: AbortSignal }): Promise<void>
  finishOAuth(
    callbackParams: URLSearchParams,
    options: McpOAuthCallbackOptions,
  ): Promise<void>
  /** Preserved current shutdown signature. */
  close(): Promise<void>
  /** Additive support-safe shutdown evidence for runtimes and harnesses. */
  closeWithReport(
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpCloseReport>
}

export declare class McpRemoteToolError extends Error {
  readonly result: McpCallToolResult
  constructor(serverName: string, toolName: string, result: McpCallToolResult)
}

export declare function createMcpHttpClient(
  options: McpHttpClientOptions,
): McpClientConnection

export declare function connectMcpHttp(
  options: McpHttpClientOptions,
): Promise<McpClientConnection>

export declare function resolveMcpReconnectOptions(
  input: McpReconnectOptions | false | undefined,
): ResolvedMcpReconnectOptions
