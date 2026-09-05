import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type AgentProvider,
  type Message,
  type Part,
  type SecurityRequirement,
  type SecurityScheme,
  type Task,
} from '@a2a-js/sdk'
import {
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server'
import type {
  AgentSession,
  AgentSessionOptions,
  DefinedAgent,
  SdkLogger,
  SupportSafeError,
} from '@ai-agent-sdk/core/agent'
import type { ModelRegistry } from '@ai-agent-sdk/core/provider'

export {
  A2A_PROTOCOL_VERSION,
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  Role,
  ServerCallContext,
  TaskState,
  type AgentCard,
  type AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type Message,
  type Part,
  type RequestContext,
  type Task,
  type TaskStore,
}

export interface DefinedAgentA2AExecutorOptions {
  readonly agent: DefinedAgent
  readonly logger?: SdkLogger
  readonly registry?: ModelRegistry
  readonly sessionOptions?: Omit<AgentSessionOptions, 'conversationId' | 'registry'>
  readonly createSession?: (
    context: RequestContext,
    signal?: AbortSignal,
  ) => AgentSession | Promise<AgentSession>
  readonly requireAuthenticated?: boolean
  readonly sessionOwner?: (
    context: RequestContext,
    signal?: AbortSignal,
  ) => string | Promise<string>
  readonly maxSessions?: number
  readonly maxRunningTasks?: number
  readonly maxTasksPerSession?: number
  readonly sessionTtlMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly disposeTimeoutMs?: number
  readonly taskTimeoutMs?: number
  readonly observerTimeoutMs?: number
  readonly exposeInternalErrors?: boolean
  readonly onError?: (error: unknown, context: RequestContext) => void | Promise<void>
}

export interface A2ADisposeReport {
  readonly status: 'disposed' | 'failed' | 'timed-out'
  readonly alreadyDisposed: boolean
  readonly error?: SupportSafeError
}

export declare class DefinedAgentA2AExecutor implements AgentExecutor {
  constructor(options: DefinedAgentA2AExecutorOptions)
  execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void>
  cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void>
  /** Preserved compatibility method. */
  dispose(reason?: unknown): Promise<void>
  /** Support-safe idempotent evidence for teardown after runtime close. */
  disposeWithReport(reason?: unknown): Promise<A2ADisposeReport>
}

export interface AgentCardFromDefinitionOptions {
  readonly url: string
  readonly protocolBinding?: 'JSONRPC' | 'HTTP+JSON' | 'GRPC' | (string & {})
  readonly version?: string
  readonly provider?: AgentProvider
  readonly documentationUrl?: string
  readonly iconUrl?: string
  readonly tags?: readonly string[]
  readonly examples?: readonly string[]
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>
  readonly securityRequirements?: readonly SecurityRequirement[]
  readonly requireHttps?: boolean
}

export declare function createAgentCardFromDefinition(
  agent: DefinedAgent,
  options: AgentCardFromDefinitionOptions,
): AgentCard

export interface DefinedAgentA2AServerOptions extends DefinedAgentA2AExecutorOptions {
  readonly agentCard: AgentCard
  readonly taskStore?: TaskStore
}

export interface DefinedAgentA2AServer {
  readonly agentCard: AgentCard
  readonly executor: DefinedAgentA2AExecutor
  readonly taskStore: TaskStore
  readonly requestHandler: DefaultRequestHandler
}

export declare function createDefinedAgentA2AServer(
  options: DefinedAgentA2AServerOptions,
): DefinedAgentA2AServer
