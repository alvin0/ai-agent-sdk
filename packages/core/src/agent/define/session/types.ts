import type { ApprovalBroker } from '../../tool/approval.ts'
import type { ToolDefinition } from '../../tool/definition.ts'
import type { ToolInterceptor } from '../../tool/pipeline.ts'
import type { SpillStore, ToolOutputOverflowPolicy } from '../../tool/output-budget.ts'
import type { ContextSection } from '../../context/types.ts'
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
  /**
   * Estimated tokens of text one tool result may put in front of the model;
   * defaults to 10,000.
   */
  readonly maxToolResultTokens?: number
  /**
   * What happens to a result over that budget; defaults to `auto`.
   *
   * `auto` spills when a spill store is mounted on the session and truncates
   * when none is. `truncate` never needs a store; `spill` falls back to
   * truncating rather than losing the result.
   */
  readonly toolResultOverflow?: ToolOutputOverflowPolicy
  /**
   * What a spent tool-call budget does to the turn; defaults to
   * `force-final-answer`.
   *
   * `continue` turns the budget into a notice rather than a wall, leaving the
   * turn bounded by steps, tokens, and the run-level ledger. Long research and
   * team leads want it: for them the useful call is usually the last one.
   * Step/loop-guard exhaustion allows one tools-disabled final report, subject
   * to token/run limits and cancellation.
   */
  readonly onExhausted?: 'force-final-answer' | 'stop' | 'continue'
  /** Default 'auto': no aggregate token ceiling. A number sets a hard stop for
   * normal rounds (including retries/finalizers), excluding compaction.
   * Summary calls use compaction limits; run reports still include their usage.
   * Mandatory usage policy applies to every call in the invocation. */
  readonly maxTotalTokens?: number | 'auto'
  /** Token headroom for one tools-disabled final report; ignored with auto total tokens. Default zero. */
  readonly finalReportReserveTokens?: number
  readonly hookTimeoutMs?: number
  readonly hookTeardownTimeoutMs?: number
  /** Maximum settlement time for each host memory-store load or commit callback. */
  readonly memoryOperationTimeoutMs?: number
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
  /**
   * Where oversized tool output is saved instead of being cut.
   *
   * Mounting one switches the `auto` overflow policy from truncating to
   * spilling, and registers the `read_tool_output` tool so the model can read
   * back what was taken out of its context.
   */
  readonly spillStore?: SpillStore
  readonly interceptors?: readonly ToolInterceptor[]
  /**
   * Model-visible context recomputed before every model round.
   *
   * Each section owns one surface node and rewrites it only when its content
   * changes. Sections perform no I/O of their own here: a filesystem-backed
   * section is built by a platform package and mounted through this option.
   */
  readonly contextSections?: readonly ContextSection[]
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
  toolsFor(sender: string, access?: 'full' | 'reporting'): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

export interface AgentSessionTeamAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  /**
   * `false` attaches no team tools; `'reporting'` withholds the blocking verbs
   * (`wait_agents`, `followup_task`), which is what an agent created for one
   * bounded task needs in order to have a stopping point.
   *
   * Spelled out rather than imported as `TeamToolAccess`: definition/session
   * ownership must not point back out at the team control plane, and the
   * repository's agent-boundary check enforces that.
   */
  readonly tools?: boolean | 'full' | 'reporting'
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
  /**
   * Model for THIS run only; the session binding is untouched and the next run
   * without an override returns to it.
   *
   * Resolved and validated before the run acquires anything, and frozen for the
   * duration of that run: every step of one turn reaches the same model, so a
   * mid-turn tool result is never answered by a model that did not see the
   * request that produced it. Switching model drops an inherited effort and
   * output ceiling — see `sessionCallConfig`.
   */
  readonly model?: { readonly provider: string; readonly model: string }
  /** Reasoning effort for this run only. Alone, it keeps the session's model. */
  readonly reasoningEffort?: import('../../../primitives/brand.ts').ReasoningEffortId
  /** Output ceiling for this run only. */
  readonly maxTokens?: number
  readonly outputFormat?: import('../../../contract/index.ts').ModelOutputFormat
  readonly validateOutput?: (value: unknown) => void
  /** strict rejects known text-only models when request history contains images; project permits lossy conversion. */
  readonly imagePolicy?: 'strict' | 'project'
  /** strict rejects models that decline document input when history contains documents; project permits lossy conversion. */
  readonly documentPolicy?: 'strict' | 'project'
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
