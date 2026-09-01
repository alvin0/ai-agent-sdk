import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ModelFailure } from '@ai-agent-sdk/core'
import type { AssistantTextPhase, ImageMediaType, NativeToolCallBlock } from '@ai-agent-sdk/core'
import type { Message } from '@ai-agent-sdk/core'
import type { MessageId, ToolCallId } from '@ai-agent-sdk/core'
import type { TokenUsage } from '@ai-agent-sdk/core'
import type { HistorySnapshot } from '../history/history.ts'
import type { ApprovalRequest } from '../tool/approval.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import type { ToolCallRequest } from '../tool/pipeline.ts'
import type { TraceEvent, TraceRef } from '../trace/trace.ts'

export type ExhaustedBudget =
  | 'steps'
  | 'tool-calls'
  | 'consecutive-tool-errors'
  | 'repeated-tool-call'
  | 'tool-call-cycle'
  | 'tokens'
export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'concluded-by-tool'; readonly toolName: string }
  | { readonly kind: 'budget-exhausted'; readonly budget: ExhaustedBudget; readonly forcedFinalAnswer: boolean }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly failure: ModelFailure }

export interface TurnOutcome {
  readonly reason: TurnEndReason
  readonly text: string
  readonly steps: number
  readonly usage: TokenUsage
  readonly toolCalls: number
  readonly traceId: string
}

interface Traced { readonly trace: TraceRef }
export type AssistantContentTiming = 'standalone' | 'before-tools' | 'after-tools' | 'between-tools'
export type StreamedAssistantTextPhase = AssistantTextPhase | 'unknown'
export type CompactionTrigger = 'pressure' | 'context-overflow' | 'manual'
export type CompactionBackoffReason = 'low-savings' | 'unreachable-threshold'
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
  | ({ readonly type: 'step-start'; readonly turn: number; readonly step: number; readonly forcedFinal?: true } & Traced)
  | ({ readonly type: 'text-delta'; readonly index: number; readonly text: string; readonly phase: StreamedAssistantTextPhase } & Traced)
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
  | ({ readonly type: 'tool-result'; readonly call: ToolCallRequest; readonly result: ToolExecutionResult } & Traced)
  | ({ readonly type: 'approval-request'; readonly request: ApprovalRequest } & Traced)
  | ({ readonly type: 'usage'; readonly usage: TokenUsage } & Traced)
  | ({ readonly type: 'step-end'; readonly turn: number; readonly step: number } & Traced)
  | ({ readonly type: 'turn-end'; readonly outcome: TurnOutcome } & Traced)

export interface BeforeStepContext {
  readonly turn: number
  readonly step: number
  readonly messages: readonly Message[]
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  emit(event: AgentMaintenanceEvent): Promise<void>
}
export type StepDecision =
  | { readonly kind: 'proceed'; readonly prepend?: readonly Message[] }
  | { readonly kind: 'reject'; readonly reason: string }
export interface RequestErrorContext {
  readonly turn: number
  readonly step: number
  readonly failure: ModelFailure
  readonly snapshot: HistorySnapshot
  readonly signal: AbortSignal
  emit(event: AgentMaintenanceEvent): Promise<void>
}
export type CheckpointContext =
  | { readonly kind: 'before-model-request'; readonly request: GenerateOptions; readonly snapshot: HistorySnapshot; readonly signal?: AbortSignal }
  | { readonly kind: 'before-tool-dispatch'; readonly call: ToolCallRequest; readonly snapshot: HistorySnapshot; readonly signal?: AbortSignal }
export interface TurnEndContext {
  readonly outcome: TurnOutcome
  readonly snapshot: HistorySnapshot
  /** True when the loop still has capacity to consume context appended by this hook. */
  readonly canContinue: boolean
}
export interface TurnHooks {
  beforeStep?(ctx: BeforeStepContext): Promise<StepDecision> | StepDecision
  onRequestError?(ctx: RequestErrorContext): Promise<'retry' | 'fail'> | 'retry' | 'fail'
  checkpoint?(ctx: CheckpointContext): Promise<void> | void
  onTurnEnd?(ctx: TurnEndContext): Promise<void> | void
}
