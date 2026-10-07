import type { AgentSession, DefinedAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ApprovalBroker, SdkLogger, ToolCatalog, ToolInterceptor } from '@alvin0/ai-agent-sdk-core/tools'
import type {
  SdkMcpCallContext,
  SdkMcpRequestContext,
} from '../common/server-public-types.ts'

export interface McpAgentSessionContext {
  readonly conversationId?: string
  readonly request: SdkMcpRequestContext
  readonly call: SdkMcpCallContext
}

export interface McpAgentTool {
  readonly name: string
  readonly description?: string
  readonly agent: DefinedAgent
  /** Host-owned persistence seam: return a fresh or resumed session. */
  readonly createSession: (context: McpAgentSessionContext) => AgentSession | Promise<AgentSession>
}

export interface McpServerErrorContext {
  readonly operation: 'tool' | 'agent'
  readonly exportName: string
  readonly requestId: string
}

export interface SdkMcpServerOptions {
  readonly name: string
  readonly version: string
  readonly logger?: SdkLogger
  /** Internal family selected by the official Web/stdio host factory. */
  readonly integrationFamily?: 'mcp-web-server' | 'mcp-stdio-server'
  readonly instructions?: string
  /** SDK tools exposed through the existing validation/policy pipeline. */
  readonly tools?: ToolCatalog
  readonly agents?: readonly McpAgentTool[]
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  /** Maximum exported tools and agents. Defaults to 1,024. */
  readonly maxExports?: number
  /** Maximum serialized export schema bytes. Defaults to 4 MiB. */
  readonly maxDefinitionBytes?: number
  /** Maximum serialized request arguments. Defaults to 1 MiB. */
  readonly maxInputBytes?: number
  /** Maximum serialized tool/agent result. Defaults to 4 MiB. */
  readonly maxOutputBytes?: number
  /** Default tool/agent operation deadline. Defaults to 10 minutes. */
  readonly operationTimeoutMs?: number
  /** Maximum wait after cancellation. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  /** Maximum time granted to the diagnostic observer. Defaults to 5 seconds. */
  readonly observerTimeoutMs?: number
  /** Report host/runtime failures without giving the observer control over request completion. */
  readonly onError?: (error: unknown, context: McpServerErrorContext) => void | Promise<void>
  /** Opt in to returning internal exception messages to remote callers. Defaults to false. */
  readonly exposeInternalErrors?: boolean
}

