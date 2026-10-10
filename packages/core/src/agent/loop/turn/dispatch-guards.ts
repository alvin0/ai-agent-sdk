import type { ExhaustedBudget, ToolDeclineReason } from '../types.ts'

export function dispatchDeclineReason(guards: {
  finalizeReason: ExhaustedBudget | undefined; tokenLimitBeforeDispatch: boolean
  timeLimitBeforeDispatch: boolean; cycleLimitBeforeDispatch: boolean; usageRequired: boolean | undefined
}): ToolDeclineReason {
  if (guards.finalizeReason !== undefined && !guards.tokenLimitBeforeDispatch) return guards.finalizeReason
  if (guards.tokenLimitBeforeDispatch) return 'tokens'
  if (guards.timeLimitBeforeDispatch) return 'time'
  if (guards.cycleLimitBeforeDispatch) return 'tool-call-cycle'
  return guards.usageRequired ? 'usage-required' : 'tool-calls'
}

export function dispatchQuota<T extends number | 'unbounded'>(
  guardDeclined: boolean, budgetIsAWall: boolean, remaining: number, openQuota: T,
): number | T {
  if (guardDeclined) return 0
  return budgetIsAWall ? remaining : openQuota
}
