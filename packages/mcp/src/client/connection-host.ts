import type { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ToolRegistry } from '@alvin0/ai-agent-sdk-core/tools'
import type {
  McpAuthenticationKind,
  McpAuthorizationState,
  McpClientLifecycleOptions,
  McpClientState,
  McpClientStatus,
  McpProtocolState,
  McpTransportFactory,
} from './api-types.ts'
import type { McpIntegrationFamily } from '../common/integration-operation.ts'

export type OAuthCapableTransport = StreamableHTTPClientTransport | SSEClientTransport
export interface PendingHttpAuthorization {
  readonly client: Client
  readonly transport: OAuthCapableTransport
}

export interface McpConnectionHost {
  readonly serverName: string
  readonly options: McpClientLifecycleOptions
  readonly transportFactory: McpTransportFactory
  readonly fallbackTransportFactory: McpTransportFactory | undefined
  readonly authenticationKind: McpAuthenticationKind
  readonly integrationFamily: McpIntegrationFamily
  readonly toolCallTimeoutMs: number
  readonly operationTimeoutMs: number
  readonly maxTools: number
  readonly maxCatalogBytes: number
  readonly maxToolResultBytes: number
  readonly registry: ToolRegistry
  toolDisposers: (() => void)[]
  current: Client | undefined
  pendingAuthorization: PendingHttpAuthorization | undefined
  syncTail: Promise<void>
  pendingToolSyncs: number
  readonly reconnectAttempts: number
  catalogRevision: number
  connectedAt: number | undefined
  readonly closed: boolean
  currentState: McpClientState
  generationDown(generation: Client): void
  scheduleReconnect(error: Error): void
  closeGeneration(generation: Client): Promise<boolean>
  publish(
    status: McpClientStatus,
    attempt: number,
    error?: Error,
    details?: { readonly authorization?: McpAuthorizationState; readonly protocol?: McpProtocolState },
  ): void
}
