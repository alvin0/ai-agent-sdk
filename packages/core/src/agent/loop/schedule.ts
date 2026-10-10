import type { History } from '../history/history.ts'
import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolCallPosition, ToolExecutionResult } from '../tool/definition.ts'
import type { SpillStore, ToolOutputOverflowPolicy } from '../tool/output-budget.ts'
import { type ToolCallRequest, type ToolInterceptor, prepareToolCall } from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import type { AgentEvent, ToolDeclineReason, TurnHooks } from './events.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { TraceRef } from '../trace/trace.ts'
import type { ProgramGrant } from '../tool/nested.ts'
import type { ProgramResultStore } from '../tool/program-results.ts'
import { createScheduleContext, applyProgress, scheduleOutcome, prepare, runExclusive, runParallel,
  immutableCall } from './schedule-impl.ts'
import type { ScheduleState } from './schedule-impl.ts'

export interface RunToolCallsOptions {
  readonly calls: readonly ToolCallRequest[]
  readonly catalog: ToolCatalog
  readonly history: History
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly logger?: SdkLogger
  readonly parentTrace: TraceRef
  readonly maxParallel?: number
  /**
   * How many BUDGETED calls may still be dispatched this step.
   *
   * Calls to a `budgetExempt` tool are not counted against it, so a spent
   * budget never blocks the model from submitting, asking, or delegating.
   */
  readonly dispatchLimit?: number
  /** Why calls past `dispatchLimit` are not run; shown to the model verbatim. */
  readonly declineReason?: ToolDeclineReason
  /** Estimated tokens of text one result may put in front of the model. */
  readonly maxResultTokens?: number
  /** What happens to output over that budget. Defaults to `auto`. */
  readonly resultOverflow?: ToolOutputOverflowPolicy
  /** Where spilled output goes; `auto` spills only when this is mounted. */
  readonly spillStore?: SpillStore
  /** Maximum serialized bytes retained for one finalized result. Defaults to 4 MiB. */
  readonly maxResultBytes?: number
  /** End-to-end wall-clock allowance for one call. Defaults to 10 minutes. */
  readonly maxDurationMs?: number
  /** Maximum cancellation settlement wait. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly emit?: (event: AgentEvent) => Promise<void>
  readonly checkpoint?: TurnHooks['checkpoint']
  readonly accounting?: RunAccountingPort
  /**
   * A same-turn result the loop may expose instead of dispatching this exact
   * call again. The scheduler still records a distinct call/result pair.
   */
  readonly recover?: (call: ToolCallRequest) => ToolExecutionResult | undefined
}
export interface ToolCallsOutcome {
  readonly results: readonly ToolExecutionResult[]
  readonly concluded: boolean
  readonly concludedBy?: string
  readonly dispatched: number
  /** Dispatched calls that spent budget; exempt tools are excluded. */
  readonly budgeted: number
  /** Calls the loop refused to run, for the reason in `declineReason`. */
  readonly declined: number
}

/** Scheduler options the loop owns and does not publish. */
export interface InternalScheduleOptions {
  /** Track actual dispatched bodies, excluding policy, declined calls and result publication. */
  readonly onToolActivity?: (awaitsPerson: boolean, active: boolean) => void
  /** Overrides `dispatchLimit`; `unbounded` when the budget is a notice rather than a wall. */
  readonly admissionLimit?: number | 'unbounded'
  /** A call-specific guard; refusing one sibling does not reserve another's quota. */
  readonly decline?: (call: ToolCallRequest) => ToolDeclineReason | undefined
  /**
   * Refuses a call even when it is budget-exempt. The finalize window uses it
   * so that only the tools a mode names (its submission) can run once the
   * budget is spent, not every tool that is normally always reachable.
   */
  readonly restrict?: (call: ToolCallRequest) => ToolDeclineReason | undefined
  /**
   * Program tools and what each may call. Research seam for SP-01; the public
   * way to enable programs is not decided.
   */
  readonly programs?: ReadonlyMap<string, ProgramGrant>
  /** Where programs retain values; owned and closed by the caller. */
  readonly programResults?: ProgramResultStore
}

/** Execute safe siblings concurrently while committing every result in model order. */
export async function runToolCalls(options: RunToolCallsOptions): Promise<ToolCallsOutcome> {
  return await scheduleToolCalls(options)
}

/** {@link runToolCalls} with the loop's internal options. */
export async function scheduleToolCalls(
  options: RunToolCallsOptions,
  internal: InternalScheduleOptions = {},
): Promise<ToolCallsOutcome> {
  const context = createScheduleContext(options, internal)
  const { maxParallel, maxResultBytes, step } = context
  const calls = Object.freeze(options.calls.map(immutableCall))
  const state: ScheduleState = { results: [], dispatched: 0, declined: 0, concludedBy: undefined }
  let index = 0
  let carried: ReturnType<typeof prepareToolCall> | undefined

  while (index < calls.length) {
    const first = calls[index]
    if (first === undefined) break
    const prepared = carried ?? prepare(options, first)
    carried = undefined
    if (prepared.mode === 'exclusive') {
      const progress = await runExclusive(
        { options, step, internal, maxResultBytes, maxParallel }, first, index, prepared,
      )
      applyProgress(state, progress)
      index = progress.nextIndex
      continue
    }
    const progress = await runParallel({ options, step, internal, maxResultBytes, maxParallel }, calls, index, prepared)
    applyProgress(state, progress)
    index = progress.nextIndex
    carried = progress.carried
  }
  return scheduleOutcome(state, step.admission.budgeted)
}


