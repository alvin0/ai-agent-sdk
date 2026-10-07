import type { ModelCallReport } from '../../../observation/index.ts'
import { budgetTokenTotal, summarizeModelCallUsage } from '../../accounting/ledger.ts'
import type { ExhaustedBudget, TurnBounds } from '../types.ts'
import type { RunTurnOptions } from './types.ts'
import type { modelRound } from './model-round.ts'
import type { ToolProgress } from './tool-progress.ts'
import { repeatKey, toolActionPattern, repeatedSuffixCycle } from './repetition.ts'
import { dispatchDeclineReason } from './dispatch-guards.ts'
import { createRepeatRecovery } from './repeat-recovery.ts'

type DispatchPreparation = {
  options: RunTurnOptions; bounds: TurnBounds; toolCalls: number; round: Awaited<ReturnType<typeof modelRound>>
  lastRepeat: ToolProgress['lastRepeat']; successfulCalls: ToolProgress['successfulCalls']; actionSteps: string[]
  modelCallReports: ModelCallReport[]; maxTotalTokens: number; finalizeUntil: number | undefined
  finalizeReason: ExhaustedBudget | undefined; timeSpent: () => number; maxTurnDurationMs: number
}

function allowsRecovery(
  repeated: boolean, cycle: boolean, tokens: boolean, ctx: DispatchPreparation,
): boolean {
  return repeated && !cycle && !tokens && !ctx.round.usageRequired
}

export function prepareDispatch(ctx: DispatchPreparation) {
    const remaining = Math.max(0, ctx.bounds.maxToolCalls - ctx.toolCalls)
    let repeatProjection: { key: string; count: number } | undefined = ctx.lastRepeat
    const projectedRepeats = ctx.round.calls.map(call => {
      const key = repeatKey(call)
      // Count consecutive calls, not lifetime visits to a source or test command.
      // Distinct intervening work may change its result. Alternating loops are
      // handled separately by the step-cycle guard below.
      const count = repeatProjection?.key === key ? repeatProjection.count + 1 : 1
      repeatProjection = { key, count }
      return count
    })
    const repeatedLimitBeforeDispatch = projectedRepeats.some(count => count >= ctx.bounds.repeatToolLimit)
    const actionPattern = toolActionPattern(ctx.round.calls)
    const projectedCycle = repeatedSuffixCycle(
      [...ctx.actionSteps, actionPattern],
      ctx.bounds.maxToolCycleLength,
    )
    const cycleLimitBeforeDispatch = projectedCycle !== undefined
      && projectedCycle.repetitions >= ctx.bounds.toolCycleLimit
    const currentUsage = summarizeModelCallUsage(ctx.modelCallReports)
    const budgetTokens = budgetTokenTotal(currentUsage)
    const tokenLimitBeforeDispatch = budgetTokens !== undefined
      && budgetTokens >= ctx.maxTotalTokens
    // A model ctx.round that ran past the time budget does not start new work.
    const timeLimitBeforeDispatch = ctx.finalizeUntil === undefined && ctx.timeSpent() >= ctx.maxTurnDurationMs
    const guardDeclined = cycleLimitBeforeDispatch || tokenLimitBeforeDispatch || ctx.round.usageRequired
      || ctx.finalizeUntil !== undefined || timeLimitBeforeDispatch
    // Name the limit that actually declined the call. Reporting a repeat guard
    // as an empty budget teaches the model the wrong lesson, and it repeats the
    // call on the next turn with the budget it was told it lacked.
    const declineReason = dispatchDeclineReason({
      finalizeReason: ctx.finalizeReason, tokenLimitBeforeDispatch, timeLimitBeforeDispatch, cycleLimitBeforeDispatch,
      usageRequired: ctx.round.usageRequired,
    })
    // `continue` takes the wall down: the budget becomes a notice and the turn
    // is bounded by steps, tokens, and the run-level ledger instead. Guards
    // that mean "this is not working" still decline, whatever the setting.
    const budgetIsAWall = ctx.bounds.onExhausted !== 'continue'
    const recoveredCallIds = new Set<string>()
    // A round-wide guard must not make an unrelated old success reusable.
    // Recovery is only legal for a call that individually reached the limit and
    // whose successful result is the immediately preceding call in this streak.
    const individuallyRepeatedCallIds = new Set(ctx.round.calls
      .filter((_call, index) => (projectedRepeats[index] ?? 0) >= ctx.bounds.repeatToolLimit)
      .map(call => String(call.callId)))
    // Only ordinary dispatches request quota: repeated calls are either recovered
    // for free or individually declined. Fresh siblings keep normal admission.
    const budgetedCalls = ctx.round.calls.filter(call =>
      !individuallyRepeatedCallIds.has(String(call.callId))
      && ctx.options.tools?.get(call.toolName)?.budgetExempt !== true).length
    const recover = allowsRecovery(repeatedLimitBeforeDispatch, cycleLimitBeforeDispatch, tokenLimitBeforeDispatch, ctx)
      ? createRepeatRecovery({ successfulCalls: ctx.successfulCalls, lastRepeat: ctx.lastRepeat,
        individuallyRepeatedCallIds, recoveredCallIds,
        tools: ctx.options.tools })
      : undefined
  return { remaining, repeatedLimitBeforeDispatch, actionPattern, projectedCycle, cycleLimitBeforeDispatch,
    budgetTokens, tokenLimitBeforeDispatch, guardDeclined, declineReason, budgetIsAWall, recoveredCallIds,
    individuallyRepeatedCallIds, budgetedCalls, recover }
}
