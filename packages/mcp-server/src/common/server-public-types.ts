import type { JsonObject } from '@alvin0/ai-agent-sdk-core'

export interface McpRequestAuthInfo {
  readonly token: string
  readonly clientId: string
  readonly scopes: readonly string[]
  readonly expiresAt?: number
  readonly resource?: URL
  readonly extra?: Record<string, unknown>
}

export interface SdkMcpRequestContext {
  readonly era: 'legacy' | 'modern'
  readonly authInfo?: McpRequestAuthInfo
  readonly requestInfo?: Request
}

export interface SdkMcpCallContext {
  readonly mcpReq: {
    readonly id: string | number
    readonly signal: AbortSignal
    readonly log: (
      level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
      data: unknown,
      logger?: string,
    ) => Promise<void>
  }
  readonly http?: {
    readonly request?: Request
    readonly authInfo?: McpRequestAuthInfo
  }
}

export interface SdkMcpHandlerRequestOptions {
  readonly authInfo?: McpRequestAuthInfo
  readonly parsedBody?: unknown
}

export interface SdkMcpEventBus {
  publish(event: JsonObject): void | Promise<void>
  subscribe?(listener: (event: JsonObject) => void): (() => void) | Promise<() => void>
}

export interface SdkMcpHandlerOptions {
  readonly legacy?: 'stateless' | 'reject'
  readonly onerror?: (error: Error) => void
  readonly responseMode?: 'auto' | 'sse' | 'json'
  readonly bus?: SdkMcpEventBus | object
  readonly maxSubscriptions?: number
  readonly keepAliveMs?: number
}

export interface SdkMcpServer {
  connect(transport: object): Promise<void>
  close(): Promise<void>
  /** Escape hatch for protocol-level operations without exporting upstream declarations. */
  readonly server: object
}

export interface SdkMcpNotifier {
  toolsChanged(): void
  promptsChanged(): void
  resourcesChanged(): void
  resourceUpdated(uri: string): void
}

export interface SdkMcpHttpHandler {
  fetch(request: Request, options?: SdkMcpHandlerRequestOptions): Promise<Response>
  close(): Promise<void>
  readonly notify: SdkMcpNotifier
  readonly bus: object
}

export interface SdkMcpCallToolResult {
  readonly [key: string]: unknown
  readonly content: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean | undefined
}
