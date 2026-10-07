import type { TurnBounds, TurnOutcome, ExhaustedBudget } from '../types.ts'
import type { modelRound } from './model-round.ts'
import type { scheduleToolCalls } from '../schedule.ts'
import { repeatKey } from './repetition.ts'

type ExhaustionContext = {
  bounds: TurnBounds; budgetTokens: number | undefined; maxTotalTokens: number; maxSteps: number
  repeatedLimitBeforeDispatch: boolean; round: Awaited<ReturnType<typeof modelRound>>
  recoveredCallIds: Set<string>; recoveredReplanKeys: Set<string>; individuallyRepeatedCallIds: Set<string>
  scheduled: Awaited<ReturnType<typeof scheduleToolCalls>>; signal: AbortSignal
  cycleLimitBeforeDispatch: boolean; tokenLimitBeforeDispatch: boolean; budgetIsAWall: boolean
  budgetedCalls: number; remaining: number; consecutiveErrors: number; repeatedLimit: boolean
  finalizeUntil: number | undefined; maxTurnDurationMs: number
  workSteps: () => number; timeSpent: () => number; admissionStop: () => TurnOutcome['reason'] | undefined
}

function replanBudgetAllows(ctx: ExhaustionContext, reserveReached: boolean): boolean {
  return !ctx.cycleLimitBeforeDispatch && !ctx.tokenLimitBeforeDispatch && !reserveReached
}

function replanRunAllows(ctx: ExhaustionContext): boolean {
  return !ctx.round.usageRequired && !ctx.round.usageUnavailable && !ctx.signal.aborted
    && !(ctx.budgetIsAWall && ctx.budgetedCalls > ctx.remaining)
    && ctx.consecutiveErrors === 0 && ctx.workSteps() < ctx.maxSteps
    && ctx.bounds.onExhausted !== 'stop' && ctx.admissionStop() === undefined
}

function canReplanRecovered(ctx: ExhaustionContext, reportReserveReached: boolean): boolean {
  return ctx.repeatedLimitBeforeDispatch
      && ctx.recoveredCallIds.size === ctx.round.calls.length
      && ctx.round.calls.every(call => ctx.recoveredCallIds.has(String(call.callId))
        && !ctx.recoveredReplanKeys.has(repeatKey(call)))
      && ctx.scheduled.results.length === ctx.round.calls.length
      && ctx.scheduled.results.every(result => !result.isError)
      && ctx.scheduled.dispatched === 0 && ctx.scheduled.declined === 0
      && replanBudgetAllows(ctx, reportReserveReached)
      && replanRunAllows(ctx)
}

function hasFreshDispatch(ctx: ExhaustionContext): boolean {
  return ctx.repeatedLimitBeforeDispatch
      && [...ctx.individuallyRepeatedCallIds].every(id => ctx.recoveredCallIds.has(id))
      && ctx.scheduled.results.length === ctx.round.calls.length
      && ctx.scheduled.dispatched > 0 && ctx.scheduled.declined === 0

}

function exhaustedBudget(
  ctx: ExhaustionContext, reportReserveReached: boolean, recoveredWithFreshDispatch: boolean,
): ExhaustedBudget | undefined {
  if (ctx.tokenLimitBeforeDispatch || reportReserveReached) return 'tokens'
  if (ctx.cycleLimitBeforeDispatch) return 'tool-call-cycle'
  if (ctx.budgetIsAWall && ctx.budgetedCalls > ctx.remaining) return 'tool-calls'
  if (ctx.consecutiveErrors >= ctx.bounds.maxConsecutiveToolErrors) return 'consecutive-tool-errors'
  if (ctx.repeatedLimit && !recoveredWithFreshDispatch) return 'repeated-tool-call'
  return ctx.workSteps() >= ctx.maxSteps ? 'steps' : undefined
}

function reachedReportReserve(ctx: ExhaustionContext): boolean {
  return ctx.bounds.maxTotalTokens !== 'auto' && ctx.bounds.finalReportReserveTokens > 0
    && ctx.budgetTokens !== undefined
    && ctx.budgetTokens >= ctx.maxTotalTokens - ctx.bounds.finalReportReserveTokens
}

function markRecoveredFreshCalls(
  ctx: ExhaustionContext, exhausted: ExhaustedBudget | undefined, recoveredWithFreshDispatch: boolean,
): void {
    if (exhausted === undefined && recoveredWithFreshDispatch) {
      for (const call of ctx.round.calls) {
        if (ctx.recoveredCallIds.has(String(call.callId))) ctx.recoveredReplanKeys.add(repeatKey(call))
      }
    }

}

export function assessExhaustion(ctx: ExhaustionContext): {
  exhausted: ExhaustedBudget | undefined; reportReserveReached: boolean
} {
    let exhausted: ExhaustedBudget | undefined
    const reportReserveReached = reachedReportReserve(ctx)
    const recoveredOnlyReplan = canReplanRecovered(ctx, reportReserveReached)
    // A repeated call cannot poison new work in the same model batch. Successful
    // recovery alongside a real dispatch is ordinary progress, not an extra pure
    // duplicate replan. The other exhaustion checks below still apply.
    const recoveredWithFreshDispatch = hasFreshDispatch(ctx)
    if (recoveredOnlyReplan) {
      for (const call of ctx.round.calls) ctx.recoveredReplanKeys.add(repeatKey(call))
    } else exhausted = exhaustedBudget(ctx, reportReserveReached, recoveredWithFreshDispatch)
    // The finalize window has its own end; only the hard token wall stops it early.
    if (ctx.finalizeUntil !== undefined) exhausted = ctx.tokenLimitBeforeDispatch ? 'tokens' : undefined
    markRecoveredFreshCalls(ctx, exhausted, recoveredWithFreshDispatch)
    // Time is checked at every step boundary, not only after tool work.
    if (exhausted === undefined && ctx.finalizeUntil === undefined
      && ctx.timeSpent() >= ctx.maxTurnDurationMs) exhausted = 'time'
    return { exhausted, reportReserveReached }
}
