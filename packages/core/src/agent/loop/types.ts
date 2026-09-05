import type {
  AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext,
  CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision,
  StreamedAssistantTextPhase, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome,
} from './events.ts'

export interface TurnBounds {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly onExhausted: 'force-final-answer' | 'stop'
  readonly maxConsecutiveToolErrors: number
  readonly repeatToolWarningAt: number
  readonly repeatToolLimit: number
  /** Repeated step-pattern cycles before a corrective reminder is injected. */
  readonly toolCycleWarningAt: number
  /** Repeated step-pattern cycles before further calls in the cycle are declined. */
  readonly toolCycleLimit: number
  /** Longest repeating sequence of tool-call steps inspected for cycles. */
  readonly maxToolCycleLength: number
  /** Maximum reported aggregate model tokens consumed by one turn. */
  readonly maxTotalTokens: number
  readonly maxParallel: number
  /** Maximum serialized bytes retained for one finalized tool result. */
  readonly maxToolResultBytes: number
  /** End-to-end wall-clock allowance for one tool call. */
  readonly maxToolDurationMs: number
  /** Maximum wait after canceling an uncooperative in-process tool. */
  readonly toolTeardownTimeoutMs: number
}

export type { AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext, CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision, StreamedAssistantTextPhase, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome }
