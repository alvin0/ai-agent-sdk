import {
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { SdkLogger, SupportSafeError } from '@alvin0/ai-agent-sdk-core'
import type { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import {
  AgentSession,
  type DefinedAgent,
  type AgentSessionOptions,
} from '@alvin0/ai-agent-sdk-core/agent'
export interface DefinedAgentA2AExecutorOptions {
  readonly agent: DefinedAgent
  readonly logger?: SdkLogger
  /** Required unless createSession supplies a fully configured session. */
  readonly registry?: ModelRegistry
  readonly sessionOptions?: Omit<AgentSessionOptions, 'conversationId' | 'registry'>
  /** Customize session construction for request-specific registries, tools, or policy. */
  readonly createSession?: (
    context: RequestContext,
    signal?: AbortSignal,
  ) => AgentSession | Promise<AgentSession>
  /** Opt-in host policy: reject calls without an authenticated A2A principal. */
  readonly requireAuthenticated?: boolean
  /**
   * Map a request to the host's ownership boundary (user, device, workspace,
   * API client, etc.). Defaults to the authenticated A2A principal.
   */
  readonly sessionOwner?: (context: RequestContext, signal?: AbortSignal) => string | Promise<string>
  /** Maximum retained context sessions. Defaults to 1,000. */
  readonly maxSessions?: number
  /** Maximum tasks executing or queued across the executor. Defaults to 1,000. */
  readonly maxRunningTasks?: number
  /** Maximum tasks executing or queued against one retained session. Defaults to 16. */
  readonly maxTasksPerSession?: number
  /** Idle session retention. Defaults to 30 minutes. */
  readonly sessionTtlMs?: number
  /** Maximum serialized inbound A2A message size. Defaults to 1 MiB. */
  readonly maxInputBytes?: number
  /** Maximum UTF-8 response size published to A2A. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number
  /** Maximum time dispose waits for cooperative providers. Defaults to 30 seconds. */
  readonly disposeTimeoutMs?: number
  /** End-to-end bound for session creation, queueing, and agent execution. Defaults to 10 minutes. */
  readonly taskTimeoutMs?: number
  /** Maximum wait for the private error observer. Defaults to 5 seconds. */
  readonly observerTimeoutMs?: number
  /** Return raw internal error text to callers. Unsafe and disabled by default. */
  readonly exposeInternalErrors?: boolean
  /** Receives the original error for private logging/telemetry. */
  readonly onError?: (error: unknown, context: RequestContext) => void | Promise<void>
}

export interface A2ADisposeReport {
  readonly status: 'disposed' | 'failed' | 'timed-out'
  readonly alreadyDisposed: boolean
  readonly error?: SupportSafeError
}

export interface ContextSession {
  readonly session: AgentSession
  tail: Promise<void>
}

export interface SessionSlot {
  readonly pending: Promise<ContextSession>
  active: number
  lastAccess: number
}

export interface RunningTask {
  readonly controller: AbortController
  readonly contextId: string
  readonly eventBus: ExecutionEventBus
  canceled: boolean
}
