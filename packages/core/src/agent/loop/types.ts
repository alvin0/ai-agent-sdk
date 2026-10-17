import type { ToolOutputOverflowPolicy } from '../tool/output-budget.ts'
import type {
  AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext,
  CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision,
  ToolDeclineReason,
  StreamedAssistantTextPhase, StreamedReasoningKind, TurnEndContext, TurnEndReason, TurnHooks, TurnOutcome,
} from './events.ts'

export interface TurnBounds {
  /** Model steps before finalization. Default 'auto': no step ceiling; set a number to opt in. */
  readonly maxSteps: number | 'auto'
  /** Tool calls per turn. Default 'auto': unlimited and no budget reminders; set a number to opt in. */
  readonly maxToolCalls: number | 'auto'
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
  /** Consecutive failed tool steps before the turn stops. Default 'auto': never stops; a reminder is sent at
   * `consecutiveToolErrorWarningAt`. */
  readonly maxConsecutiveToolErrors: number | 'auto'
  /** Consecutive failed tool steps before a corrective reminder. Default 4. */
  readonly consecutiveToolErrorWarningAt: number
  /** Consecutive identical calls before a corrective reminder. */
  readonly repeatToolWarningAt: number
  /** Consecutive identical calls before declining further repetition. Default 'auto': warn only. */
  readonly repeatToolLimit: number | 'auto'
  /** Repeated step-pattern cycles before a corrective reminder is injected. */
  readonly toolCycleWarningAt: number
  /** Repeated step-pattern cycles before further calls in the cycle are declined. Default 'auto': warn only. */
  readonly toolCycleLimit: number | 'auto'
  /** Longest repeating sequence of tool-call steps inspected for cycles. */
  readonly maxToolCycleLength: number
  /** Maximum aggregate model tokens per turn. Default 'auto' imposes no total-token ceiling. */
  readonly maxTotalTokens: number | 'auto'
  /** Stop tool work this many tokens before the hard total to reserve a report.
   * Ignored with maxTotalTokens: 'auto'. Zero disables the reserve. */
  readonly finalReportReserveTokens: number
  /**
   * Extra steps a turn may take after its budget forced a final answer, used
   * only when the caller supplies `RunTurnOptions.finalize` (deep mode does,
   * defaulting this to 2). In them only the tools it names run, so a run that
   * answered on its last step can still confirm that answer instead of ending
   * unconfirmed. Zero (the default) ends the turn at the forced answer.
   */
  readonly finalizeSteps: number
  /**
   * Wall-clock budget for the turn's work, excluding time spent waiting for a
   * person. When it passes, the turn stops working and answers from what it
   * has, like any other spent budget, rather than being cancelled with
   * nothing. A model round already in flight is not interrupted. Default
   * 'auto' imposes no time budget.
   */
  readonly maxTurnDurationMs: number | 'auto'
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
  /** End-to-end wall-clock allowance for one tool call. Default 'auto': no deadline; set a number to opt in. */
  readonly maxToolDurationMs: number | 'auto'
  /** Maximum wait after canceling an uncooperative in-process tool. */
  readonly toolTeardownTimeoutMs: number
}

/** Limits that accept 'auto' resolve to Infinity, so count comparisons never trip. */
type UnlimitedBound = 'maxToolCalls' | 'maxConsecutiveToolErrors' | 'repeatToolLimit' | 'toolCycleLimit'
  | 'maxToolDurationMs'
export type ResolvedTurnBounds = Omit<TurnBounds, UnlimitedBound> & { readonly [K in UnlimitedBound]: number }

export type {
  AgentEvent, AgentMaintenanceEvent, AssistantContentTiming, BeforeStepContext, CheckpointContext,
  CompactionBackoffReason, CompactionTrigger, ExhaustedBudget, RequestErrorContext, StepDecision,
  StreamedAssistantTextPhase, StreamedReasoningKind, ToolDeclineReason, TurnEndContext, TurnEndReason, TurnHooks,
  TurnOutcome,
}
