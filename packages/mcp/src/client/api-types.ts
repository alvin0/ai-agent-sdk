import type { ToolCatalog, ToolFilter } from '@alvin0/ai-agent-sdk-core/tools'
import type { JsonObject, JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core'
import type { SupportSafeError } from '@alvin0/ai-agent-sdk-core'
import type {
  McpSseTransportOptions,
  McpStreamableHttpTransportOptions,
  McpTransport,
  McpVersionNegotiationMode,
} from './public-types.ts'

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

export type McpClientStatus = 'idle' | 'connecting' | 'authorization-required'
  | 'authentication-required' | 'authentication-failed' | 'oauth-authorization-required'
  | 'scope-authorization-required' | 'ready' | 'reconnecting' | 'failed' | 'closed'
export type McpAuthenticationKind = 'none' | 'bearer' | 'oauth' | 'unknown'
export type McpTransportKind = 'streamable-http' | 'sse' | 'custom'

export interface McpAuthorizationState {
  readonly kind: McpAuthenticationKind
  readonly reason: 'credentials-required' | 'invalid-credentials' | 'authorization-code-required' | 'insufficient-scope'
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
  readonly error?: Error
  readonly authorization?: McpAuthorizationState
  readonly protocol?: McpProtocolState
  readonly catalogRevision: number
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
  /**
   * Final host policy hook, awaited immediately before every request and
   * redirect under the operation's absolute deadline. The signal is cancelled
   * on caller abort or timeout. A server can resolve DNS here; pair it with a
   * fetch/egress layer that pins the validated address to eliminate
   * validation/connect races.
   */
  readonly validateEndpoint?: (url: URL, signal: AbortSignal) => void | Promise<void>
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
  /** Internal transport family supplied by the official HTTP/stdio factories. */
  readonly integrationFamily?: 'mcp-http-client' | 'mcp-stdio-client'
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

export interface McpConnectionPublicShape {
  readonly serverName: string
  readonly tools: ToolCatalog
}
