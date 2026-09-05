import type {
  AgentSession,
  DefinedAgent,
  RuntimeAgent,
} from '@ai-agent-sdk/core/agent'
import type {
  ApprovalBroker,
  SdkLogger,
  ToolCatalog,
  ToolInterceptor,
} from '@ai-agent-sdk/core/tools'

export interface SdkMcpRequestContext {
  readonly era: 'legacy' | 'modern'
  readonly authInfo?: object
  readonly requestInfo?: Request
}

export interface SdkMcpCallContext {
  readonly mcpReq: {
    readonly id: string | number
    readonly signal: AbortSignal
  }
  readonly http?: { readonly request?: Request; readonly authInfo?: object }
}

export interface SdkMcpHandlerOptions {
  readonly legacy?: 'stateless' | 'reject'
  readonly onerror?: (error: Error) => void
  readonly responseMode?: 'auto' | 'sse' | 'json'
  readonly bus?: object
  readonly maxSubscriptions?: number
  readonly keepAliveMs?: number
}

export interface SdkMcpServer {
  connect(transport: object): Promise<void>
  close(): Promise<void>
  readonly server: object
}

export interface SdkMcpHttpHandler {
  fetch(request: Request, options?: { readonly authInfo?: object; readonly parsedBody?: unknown }): Promise<Response>
  close(): Promise<void>
  readonly notify: object
  readonly bus: object
}

export interface McpAgentSessionContext {
  readonly conversationId?: string
  readonly request: SdkMcpRequestContext
  readonly call: SdkMcpCallContext
}

export interface McpAgentTool {
  readonly name: string
  readonly description?: string
  readonly agent: DefinedAgent
  readonly createSession: (
    context: McpAgentSessionContext,
  ) => AgentSession | Promise<AgentSession>
}

export interface McpServerErrorContext {
  readonly operation: 'tool' | 'agent'
  readonly exportName: string
  readonly requestId: string
}

/** Existing advanced server surface, moved under P0-14 without thinning it. */
export interface SdkMcpServerOptions {
  readonly name: string
  readonly version: string
  readonly instructions?: string
  readonly tools?: ToolCatalog
  readonly agents?: readonly McpAgentTool[]
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly maxExports?: number
  readonly maxDefinitionBytes?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly operationTimeoutMs?: number
  readonly teardownTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly onError?: (
    error: unknown,
    context: McpServerErrorContext,
  ) => void | Promise<void>
  readonly exposeInternalErrors?: boolean
  readonly logger?: SdkLogger
}

export declare function createSdkMcpServer(
  options: SdkMcpServerOptions,
  request?: SdkMcpRequestContext,
): SdkMcpServer

export declare function createSdkMcpHandler(
  options: SdkMcpServerOptions,
  handlerOptions?: SdkMcpHandlerOptions,
): SdkMcpHttpHandler

/** Preferred runtime-definition surface for normal composition. */
export interface McpServerDefinition {
  readonly id: string
  readonly logger?: SdkLogger
  readonly tools?: ToolCatalog
  readonly agents?: Readonly<Record<string, RuntimeAgent>>
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
}

export interface McpWebServer {
  handle(
    request: Request,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Response>
}

export declare function createMcpServer(
  definition: McpServerDefinition,
): McpWebServer
