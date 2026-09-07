import type {
  AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext,
  CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision,
  StreamedAssistantTextPhase, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome,
} from './events.ts'

export interface TurnBounds {
  readonly maxSteps: number
  readonly maxToolCalls: number
  /**
   * Remaining-call counts at which the turn tells the model how much is left.
   *
   * One reminder per threshold crossed, so a turn that keeps spending keeps
   * being told — the shape Codex uses for its token budget. A single warning
   * is not enough: warned once at a quarter left and still exploring at two,
   * a model hits the wall with no notice and the turn ends in a failed tool
   * call instead of an answer.
   *
   * Thresholds outside `1..maxToolCalls - 1` are ignored, so a list written
   * for a larger budget stays valid. Empty disables the reminders.
   */
  readonly toolBudgetRemindAt: readonly number[]
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
