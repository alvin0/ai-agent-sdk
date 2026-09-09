import type { JsonObject } from '@alvin0/ai-agent-sdk-core'

/** Protocol-selection surface owned by the SDK so Web consumers do not inherit Node ambient types. */
export type McpVersionNegotiationMode = 'legacy' | 'auto' | { readonly pin: string }

export interface McpBearerAuthProvider {
  token(): Promise<string | undefined>
  onUnauthorized?(context: { readonly response: Response; readonly resourceMetadataUrl?: URL }): Promise<void>
}

/**
 * OAuth providers intentionally remain structural. The MCP protocol package accepts richer
 * provider objects; this boundary keeps them portable without copying that package's full API.
 */
export type McpAuthenticationProvider = McpBearerAuthProvider | object

export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface McpStreamableHttpReconnectionOptions {
  readonly maxReconnectionDelay: number
  readonly initialReconnectionDelay: number
  readonly reconnectionDelayGrowFactor: number
  readonly maxRetries: number
}

export interface McpStreamableHttpTransportOptions {
  readonly authProvider?: McpAuthenticationProvider
  readonly skipIssuerMetadataValidation?: boolean
  readonly requestInit?: RequestInit
  readonly fetch?: McpFetch
  readonly reconnectionOptions?: McpStreamableHttpReconnectionOptions
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
  readonly authProvider?: McpAuthenticationProvider
  readonly skipIssuerMetadataValidation?: boolean
  readonly eventSourceInit?: { readonly fetch?: McpFetch }
  readonly requestInit?: RequestInit
  readonly fetch?: McpFetch
}

export interface McpTransport {
  start(): Promise<void>
  send(...args: never[]): Promise<void>
  close(): Promise<void>
  readonly hasPerRequestStream?: boolean
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: ((...args: never[]) => void) | undefined
}

export interface McpRemoteToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: JsonObject
  readonly outputSchema?: JsonObject
  readonly annotations?: JsonObject
}

export interface McpCallToolResult {
  readonly [key: string]: unknown
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean | undefined
}

/** Common raw-protocol operations available without importing the upstream declaration graph. */
export interface McpProtocolClient {
  callTool(
    params: { readonly name: string; readonly arguments?: JsonObject },
    options?: {
      readonly signal?: AbortSignal
      readonly timeout?: number
      readonly toolDefinition?: McpRemoteToolDefinition
    },
  ): Promise<McpCallToolResult>
  listTools(params?: JsonObject, options?: object): Promise<{
    readonly tools: readonly McpRemoteToolDefinition[]
    readonly nextCursor?: string
  }>
  listResources(params?: JsonObject, options?: object): Promise<JsonObject>
  readResource(params: { readonly uri: string; readonly _meta?: JsonObject }, options?: object): Promise<JsonObject>
  listPrompts(params?: JsonObject, options?: object): Promise<JsonObject>
  getPrompt(params: { readonly name: string; readonly arguments?: JsonObject }, options?: object): Promise<JsonObject>
  ping(options?: object): Promise<JsonObject>
  close(): Promise<void>
}
