import type { ToolOutputOverflowPolicy } from '../tool/output-budget.ts'
import type {
  AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext,
  CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision,
  ToolDeclineReason,
  StreamedAssistantTextPhase, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome,
} from './events.ts'

export interface TurnBounds {
  /** Model steps before finalization; 'auto' removes only the step ceiling. */
  readonly maxSteps: number | 'auto'
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
  /**
   * What a spent budget does to the turn.
   *
   * - `force-final-answer` (default) — stop dispatching and take one last model
   *   round for the answer.
   * - `stop` — end the turn where it stands.
   * - `continue` — the tool-call budget stops being a wall and becomes a
   *   notice: calls keep running, and the turn is bounded by `maxSteps`,
   *   `maxTotalTokens`, and the run-level ledger limits instead. This is the
   *   shape both reference harnesses use — neither fails a tool call to
   *   enforce a budget — and it is the right choice for long research or team
   *   work, where the useful call is often the last one. Step and loop-guard
   *   exhaustion still allows one tools-disabled summary. Token and run-level
   *   limits, or cancellation, never grant an extra model call.
   */
  readonly onExhausted: 'force-final-answer' | 'stop' | 'continue'
  readonly maxConsecutiveToolErrors: number
  /** Consecutive identical calls before a corrective reminder. */
  readonly repeatToolWarningAt: number
  /** Consecutive identical calls before declining further repetition. */
  readonly repeatToolLimit: number
  /** Repeated step-pattern cycles before a corrective reminder is injected. */
  readonly toolCycleWarningAt: number
  /** Repeated step-pattern cycles before further calls in the cycle are declined. */
  readonly toolCycleLimit: number
  /** Longest repeating sequence of tool-call steps inspected for cycles. */
  readonly maxToolCycleLength: number
  /** Maximum aggregate model tokens per turn. Default 'auto' imposes no total-token ceiling. */
  readonly maxTotalTokens: number | 'auto'
  /** Stop tool work this many tokens before the hard total to reserve a report.
   * Ignored with maxTotalTokens: 'auto'. Zero disables the reserve. */
  readonly finalReportReserveTokens: number
  readonly maxParallel: number
  /** Maximum serialized bytes retained for one finalized tool result. */
  readonly maxToolResultBytes: number
  /**
   * Estimated tokens of text ONE tool result may put in front of the model.
   *
   * Defaults to 10,000, the same allowance Codex gives a shell call. The byte
   * cap above is a storage bound measured in megabytes; this is the context
   * bound, and it is the one that decides whether a turn survives a `cat` of a
   * generated file. A tool may lower its own share with
   * `ToolDefinition.maxOutputTokens`.
   */
  readonly maxToolResultTokens: number
  /**
   * What happens to a result over that budget. Defaults to `auto`.
   *
   * `auto` spills when a store is mounted and truncates when none is, so the
   * cheap path works everywhere and the lossless one turns itself on the
   * moment it can.
   */
  readonly toolResultOverflow: ToolOutputOverflowPolicy
  /** End-to-end wall-clock allowance for one tool call. */
  readonly maxToolDurationMs: number
  /** Maximum wait after canceling an uncooperative in-process tool. */
  readonly toolTeardownTimeoutMs: number
}

export type { AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext, CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision, StreamedAssistantTextPhase, ToolDeclineReason, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome }
