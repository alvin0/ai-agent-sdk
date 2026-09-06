import type { ApprovalBroker } from '../../tool/approval.ts'
import type { ToolDefinition } from '../../tool/definition.ts'
import type { ToolInterceptor } from '../../tool/pipeline.ts'
import { type ToolCatalog } from '../../tool/registry.ts'
import { History, type HistoryLimits, type HistorySnapshot } from '../../history/history.ts'
import type { TurnHooks } from '../../loop/types.ts'
import { type AgentCompactionOptions } from '../../memory/compaction-config.ts'
import { AgentMemory, type AgentMemorySnapshot } from '../../memory/memory.ts'
import { type AgentRunEvent, type AgentRunOutcome } from '../../mode/run-agent.ts'
import type { UserInputBroker } from '../../mode/user-input.ts'
import type { Message, UserMessage } from '../../../message/index.ts'
import type { ModelRegistry } from '../../../runtime/index.ts'
import type { ObservationPort, ObservationResource } from '../../../observation/index.ts'
import type { SpanId, TraceId } from '../../trace/trace.ts'
import type { RunLedgerLimits, UsagePolicy } from '../../accounting/report.ts'
import type { RunReport } from '../../accounting/delivery-types.ts'
import { type SkillResourceBase, type SkillSource } from '../../skill/index.ts'
import type { AgentSession } from '../session.ts'
import type { JsonValue } from '../../../primitives/index.ts'

export type AgentInput = string | UserMessage

/** Deployment-neutral resource guards for normal model/tool turns in one session. */
export interface AgentRuntimeLimits {
  readonly teardownTimeoutMs?: number
  readonly modelTimeoutMs?: number
  readonly maxModelRequestBytes?: number
  readonly maxModelResponseBytes?: number
  readonly maxModelStreamEvents?: number
  readonly maxToolResultBytes?: number
  readonly maxToolDurationMs?: number
  readonly toolTeardownTimeoutMs?: number
  readonly maxParallelToolCalls?: number
  readonly maxConsecutiveToolErrors?: number
  readonly repeatToolWarningAt?: number
  readonly repeatToolLimit?: number
  readonly toolCycleWarningAt?: number
  readonly toolCycleLimit?: number
  readonly maxToolCycleLength?: number
  /** Hard stop over aggregate usage reported by model adapters. */
  readonly maxTotalTokens?: number
  readonly hookTimeoutMs?: number
  readonly hookTeardownTimeoutMs?: number
  /** Maximum time granted to each invocation event observer. Defaults to 30 seconds. */
  readonly observerTimeoutMs?: number
}

export interface AgentRunEventBufferLimits {
  readonly maxEvents?: number
  readonly maxBytes?: number
}

export interface AgentSessionOptions {
  readonly registry: ModelRegistry
  /** Stable application-facing id; generated automatically when omitted. */
  readonly conversationId?: string
  /** Resume an existing history; otherwise the session starts empty. */
  readonly history?: History
  /** In-memory append-only history resource limits. */
  readonly historyLimits?: HistoryLimits
  /** Per-session model/tool resource guards; safe defaults apply when omitted. */
  readonly runtimeLimits?: AgentRuntimeLimits
  /** Application tools added to the tools declared by the agent. */
  readonly tools?: ToolCatalog | readonly ToolDefinition<any>[]
  /** Per-session sources, filtered by the definition's skillIds when declared. */
  readonly skills?: readonly SkillSource[]
  /** Workspace selector forwarded to cwd-sensitive skill providers. */
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly hooks?: TurnHooks
  /** Pluggable delivery backend for canonical run/model/tool observations. */
  readonly observation?: ObservationPort
  /** Deployment metadata attached to every canonical observation event. */
  readonly observationResource?: ObservationResource
  /** Missing provider-usage behavior; defaults to a warning with unknown totals. */
  readonly usagePolicy?: UsagePolicy
  /** Hard resource limits for the in-memory canonical run ledger. */
  readonly ledgerLimits?: RunLedgerLimits
  /** Hard resource limits for public run events waiting on a consumer. */
  readonly eventBufferLimits?: AgentRunEventBufferLimits
  /** Resume explicit task memory; otherwise definition seeds are used. */
  readonly memory?: AgentMemory | AgentMemorySnapshot
  /** Override the definition's compaction policy for this conversation. */
  readonly compaction?: AgentCompactionOptions | false
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
  }
  /** Join one shared local/remote agent team and optionally expose its model tools. */
  readonly team?: AgentTeamMemberOptions
}

export interface AgentSessionTeamPort {
  attach(session: AgentSession, options?: AgentSessionTeamAttachmentOptions): void
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

export interface AgentSessionTeamAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
}

/** Attach a session to one shared local/remote agent control plane. */
export interface AgentTeamMemberOptions extends AgentSessionTeamAttachmentOptions {
  readonly team: AgentSessionTeamPort
}

/** One JSON-safe envelope containing everything needed to resume a conversation. */
export interface AgentSessionSnapshot {
  readonly version: 1
  readonly conversationId: string
  readonly agentId: string
  readonly history: HistorySnapshot
  readonly memory: AgentMemorySnapshot
  /** Optional in v1 so snapshots written before skill support remain valid. */
  readonly skills?: {
    /** Bodies/resources are never persisted here; current providers rehydrate them lazily. */
    readonly activated: readonly AgentSessionActivatedSkillSnapshot[]
  }
}

export interface AgentSessionActivatedSkillSnapshot {
  readonly id: string
  readonly provider: string
  readonly source: string
  readonly catalogRevision?: string
  readonly locator?: JsonValue
  /** Prevent a resumed session from silently switching scoped resource bundles. */
  readonly resourceBase?: SkillResourceBase
}

/** Runtime dependencies used when opening a persisted conversation. */
export interface AgentResumeSessionOptions
  extends Omit<AgentSessionOptions, 'conversationId' | 'history' | 'memory'> {
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentInvocationOptions {
  readonly signal?: AbortSignal
  /** Observe events when using run()/runPending(); stream() already exposes them directly. */
  readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
}

export interface AgentResponse {
  readonly text: string
  readonly outcome: AgentRunOutcome
  readonly report: RunReport
  readonly message?: Message
}

/** Eager single-consumer event stream with independently awaitable terminal artifacts. */
export interface AgentRunHandle extends AsyncIterable<AgentRunEvent> {
  readonly runId: string
  readonly result: Promise<AgentResponse>
  readonly report: Promise<RunReport>
}
