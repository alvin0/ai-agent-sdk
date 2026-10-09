import type { GenerateOptions } from '../../contract/index.ts'
import type { ModelFailure } from '../../errors/index.ts'
import type { AssistantTextPhase, ImageMediaType, NativeToolCallBlock } from '../../message/index.ts'
import type { Message } from '../../message/index.ts'
import type { MessageId, ToolCallId } from '../../primitives/index.ts'
import type { TokenUsage } from '../../stream/index.ts'
import type { CompactionBackoffReason, HistorySnapshot } from '../history/history.ts'

export type { CompactionBackoffReason } from '../history/history.ts'
import type { ApprovalRequest } from '../tool/approval.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import type { ToolCallRequest } from '../tool/pipeline.ts'
import type { TraceEvent, TraceRef } from '../trace/trace.ts'
import type { RunUsageReport } from '../accounting/report.ts'
import type { SdkLogger } from '../../logging/types.ts'

export type ExhaustedBudget =
  | 'steps'
  | 'tool-calls'
  | 'consecutive-tool-errors'
  | 'repeated-tool-call'
  | 'tool-call-cycle'
  | 'tokens'
  /** `TurnBounds.maxTurnDurationMs` passed; the answer was forced from the evidence so far. */
  | 'time'
/**
 * Why a call the model asked for was not run.
 *
 * A declined call is not a failed call: nothing broke, the loop simply refused
 * to spend more on exploration. The distinction matters to the model, which
 * answers a failure by retrying and a refusal by finishing.
 */
export type ToolDeclineReason = ExhaustedBudget | 'usage-required'

export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'concluded-by-tool'; readonly toolName: string }
  | { readonly kind: 'budget-exhausted'; readonly budget: ExhaustedBudget; readonly forcedFinalAnswer: boolean;
      /** Exploration stopped at the reporting reserve, before the hard token ceiling. */
      readonly trigger?: 'report-reserve' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'usage-unavailable'; readonly modelCallId: string }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly failure: ModelFailure }

export interface TurnOutcome {
  readonly reason: TurnEndReason
  readonly text: string
  readonly steps: number
  /** Exact legacy aggregate; absent whenever any possibly-billed call lacks authoritative usage. */
  readonly usage?: TokenUsage
  /** Canonical coverage-aware usage for every logical model call in this turn. */
  readonly usageReport: RunUsageReport
  readonly toolCalls: number
  readonly traceId: string
}

interface Traced { readonly trace: TraceRef }
export type AssistantContentTiming = 'standalone' | 'before-tools' | 'after-tools' | 'between-tools'
export type StreamedAssistantTextPhase = AssistantTextPhase | 'unknown'
export type CompactionTrigger = 'pressure' | 'context-overflow' | 'manual'
export type AgentMaintenanceEvent =
  | {
    readonly type: 'compaction-start'
    readonly compactionId: string
    readonly trigger: CompactionTrigger
    readonly estimatedInputTokens: number
  }
  | {
    readonly type: 'compaction-end'
    readonly compactionId: string
    readonly trigger: CompactionTrigger
    readonly status: 'completed' | 'failed'
    readonly shadowedSeqs: readonly number[]
    readonly estimatedTokensBefore: number
    readonly estimatedTokensAfter: number
    readonly thresholdTokens?: number
    readonly estimatedNonCompactableTokens?: number
    readonly backoffReason?: CompactionBackoffReason
    readonly cooldownSteps?: number
    readonly summary?: string
    readonly error?: string
    readonly usage?: TokenUsage
  }
export type AgentEvent = TraceEvent
  | (AgentMaintenanceEvent & Traced)
  | ({ readonly type: 'turn-start'; readonly turn: number } & Traced)
  | ({
    readonly type: 'step-start'
    readonly turn: number
    readonly step: number
    readonly forcedFinal?: true
  } & Traced)
  | ({
    readonly type: 'text-delta'
    readonly index: number
    readonly text: string
    readonly phase: StreamedAssistantTextPhase
  } & Traced)
  /** Authoritative text and phase for a model-round block, before step-end.
   * A final-answer block is local to this agent/round, not whole-team completion.
   * incomplete marks output retained from an error, abort or output-token limit. */
  | ({
    readonly type: 'text-end'
    readonly index: number
    readonly text: string
    readonly phase: AssistantTextPhase
    readonly incomplete?: true
  } & Traced)
  | ({ readonly type: 'reasoning-delta'; readonly index: number; readonly text: string } & Traced)
  | ({
    readonly type: 'image-delta'
    readonly itemId: string
    readonly data: string
    readonly mediaType: ImageMediaType
    readonly partialIndex?: number
  } & Traced)
  | ({ readonly type: 'assistant-message'; readonly message: Message } & Traced)
  | ({
    readonly type: 'assistant-text'
    readonly messageId: MessageId
    readonly text: string
    readonly phase: AssistantTextPhase
    readonly timing: AssistantContentTiming
    readonly toolCallIds: readonly ToolCallId[]
    readonly afterToolCallIds: readonly ToolCallId[]
  } & Traced)
  | ({
    readonly type: 'assistant-native-tool'
    readonly messageId: MessageId
    readonly call: NativeToolCallBlock
  } & Traced)
  | ({
    /** Provider-emitted reasoning summary/content, never fabricated hidden chain-of-thought. */
    readonly type: 'assistant-reasoning'
    readonly messageId: MessageId
    readonly text: string
    readonly timing: AssistantContentTiming
    readonly toolCallIds: readonly ToolCallId[]
    readonly afterToolCallIds: readonly ToolCallId[]
  } & Traced)
  | ({ readonly type: 'tool-call'; readonly call: ToolCallRequest } & Traced)
  | ({
    readonly type: 'tool-result'; readonly call: ToolCallRequest; readonly result: ToolExecutionResult
    /** The loop refused the call; no tool body ran. Set by the scheduler, never by a tool. */
    readonly declined?: true
    /** Answered from this turn's earlier identical result; no tool body ran. */
    readonly recovered?: true
    /**
     * False when the tool body never ran: declined, recovered, denied by an
     * interceptor or approval, or cancelled before it started.
     */
    readonly dispatched?: false
  } & Traced)
  | ({ readonly type: 'approval-request'; readonly request: ApprovalRequest } & Traced)
  | ({ readonly type: 'usage'; readonly usage: TokenUsage } & Traced)
  | ({
    readonly type: 'usage-progress'
    readonly usage: import('../../observation/usage.ts').UsageCounters
    readonly attemptId?: string
  } & Traced)
  | ({ readonly type: 'step-end'; readonly turn: number; readonly step: number } & Traced)
  | ({ readonly type: 'turn-end'; readonly outcome: TurnOutcome } & Traced)

export interface BeforeStepContext {
  readonly turn: number
  /** Request number in the turn; retried requests take numbers too. */
  readonly step: number
  /**
   * The work step this request is for, which is what `maxSteps` limits:
   * retried requests do not advance it. Past `maxSteps` the request is the
   * forced answer or the finalize window, where tools are not available for
   * work, so cues tied to a step budget should not be sent there.
   */
  readonly workStep?: number
  /** `forced-final`: the tools-off answer a budget forced; `final`: a structured-output finalizer. */
  readonly phase?: 'standard' | 'process' | 'final' | 'forced-final'
  /** Set in the finalize window, where only the mode's confirmation tool runs. */
  readonly finalizing?: true
  readonly messages: readonly Message[]
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  emit(event: AgentMaintenanceEvent): Promise<void>
}
export type StepDecision =
  | { readonly kind: 'proceed'; readonly prepend?: readonly Message[];
      /** Model-only projection. Raw history and checkpoint snapshots remain unchanged. */
      readonly messages?: readonly Message[] }
  | { readonly kind: 'reject'; readonly reason: string }
export interface RequestErrorContext {
  readonly turn: number
  readonly step: number
  readonly failure: ModelFailure
  /**
   * Failed model requests in a row in this turn, this one included. A request
   * that succeeds resets it, so a retry limit read from it applies per outage
   * rather than to the whole turn.
   */
  readonly consecutiveFailures: number
  /**
   * Retries already granted in this turn, across every outage, by whichever
   * hook granted them (the session's own overflow compaction included).
   */
  readonly retries: number
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  emit(event: AgentMaintenanceEvent): Promise<void>
}
export type CheckpointContext =
  | { readonly kind: 'before-model-request'; readonly request: GenerateOptions; readonly snapshot: HistorySnapshot;
      readonly signal?: AbortSignal; readonly logger?: SdkLogger }
  | { readonly kind: 'before-tool-dispatch'; readonly call: ToolCallRequest; readonly snapshot: HistorySnapshot;
      /** Set when a program tool made this call; the id of that outer call. */
      readonly parentCallId?: ToolCallRequest['callId']
      readonly signal?: AbortSignal; readonly logger?: SdkLogger }
export interface TurnEndContext {
  readonly outcome: TurnOutcome
  readonly snapshot: HistorySnapshot
  /** True when the loop still has capacity to consume context appended by this hook. */
  readonly canContinue: boolean
}
export interface TurnHooks {
  readonly beforeStep?: (ctx: BeforeStepContext) => Promise<StepDecision> | StepDecision
  readonly onRequestError?: (ctx: RequestErrorContext) => Promise<'retry' | 'fail'> | 'retry' | 'fail'
  readonly checkpoint?: (ctx: CheckpointContext) => Promise<void> | void
  readonly onTurnEnd?: (ctx: TurnEndContext) => Promise<void> | void
}
