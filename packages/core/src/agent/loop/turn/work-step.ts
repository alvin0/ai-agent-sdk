import { modelRound } from './model-round.ts'
import { accountingUsageStop } from './usage-stop.ts'
import { remindTurnBudgets } from './budget-reminders.ts'
import { prepareDispatch } from './dispatch-preparation.ts'
import { recordToolResults } from './tool-progress.ts'
import { remindToolBudget } from './tool-budget-reminders.ts'
import { processModelRound } from './round-decision.ts'
import { warnToolCycle } from './tool-warnings.ts'
import { assessExhaustion } from './exhaustion.ts'
import { dispatchRoundTools } from './dispatch-scheduler.ts'
import { roundUsageStop, roundPhase } from './round-commit.ts'
import { forceAnswer } from './final-round.ts'

import type { TurnState } from './state.ts'

type Round = Awaited<ReturnType<typeof modelRound>>
type Prepared = ReturnType<typeof prepareDispatch>
type Scheduled = Awaited<ReturnType<typeof dispatchRoundTools>>

async function prepareWorkRound(state: TurnState): Promise<boolean> {
  state.reason = state.admissionStop()
  if (state.reason !== undefined) return false
  if (state.steps > 0 && state.finalizeUntil === undefined && state.timeSpent() >= state.maxTurnDurationMs) {
    state.reason = state.bounds.onExhausted === 'stop'
      ? { kind: 'budget-exhausted', budget: 'time', forcedFinalAnswer: false }
      : await forceAnswer(state.finalContext, 'time', false)
    return false
  }
  remindTurnBudgets(state)
  if (state.contextSections !== undefined) {
    await state.contextSections.reconcile(state.steps, state.contextTouches, state.signal)
    state.contextTouches = []
  }
  return true
}

async function requestRound(state: TurnState) {
  const step = state.steps + 1
  const round = await modelRound({ ...state, step,
    phase: roundPhase(state.options, state.dedicatedFinalOutput), position: state.position() })
  state.steps++
  if (round.report !== undefined) state.modelCallReports.push(round.report)
  state.usageStop = roundUsageStop(state.options, round)
  const decision = await processModelRound({ ...state, limit: state.finalizeUntil ?? state.maxSteps }, round, step)
  return { step, round, decision }
}

function recordDispatch(state: TurnState, round: Round, prepared: Prepared, scheduled: Scheduled) {
  // Results commit in model order; a short list means the scheduler is unwinding.
  if (state.contextSections !== undefined && scheduled.results.length === round.calls.length) {
    state.contextTouches.push(...round.calls.map((call, index) => ({
      toolName: call.toolName, rawArguments: call.rawArguments, failed: scheduled.results[index]?.isError ?? true,
    })))
  }
  state.toolCalls += scheduled.budgeted
  const reminders = { ...state, maxToolCalls: state.bounds.maxToolCalls, budgetIsAWall: prepared.budgetIsAWall }
  remindToolBudget(reminders)
  state.budgetRemindersSent = reminders.budgetRemindersSent
  state.overBudgetNoticesSent = reminders.overBudgetNoticesSent
}

function recordProgress(state: TurnState, round: Round, prepared: Prepared, scheduled: Scheduled) {
  state.actionSteps.push(prepared.actionPattern)
  const progress = { ...state, repeatedLimit: prepared.repeatedLimitBeforeDispatch }
  recordToolResults(progress, round.calls, scheduled.results)
  state.consecutiveErrors = progress.consecutiveErrors
  state.lastRepeat = progress.lastRepeat
  warnToolCycle(state.options, prepared.projectedCycle, state.bounds.toolCycleWarningAt)
  return progress.repeatedLimit
}

function dispatchedStop(state: TurnState, round: Round, scheduled: Scheduled) {
  if (scheduled.concluded) {
    state.reason = { kind: 'concluded-by-tool', toolName: scheduled.concludedBy ?? 'unknown' }
    return true
  }
  if (state.signal.aborted) { state.reason = { kind: 'aborted' }; return true }
  if (round.usageRequired) { state.reason = state.usageStop; return true }
  if (round.usageUnavailable) {
    state.reason = accountingUsageStop(state.options.accounting) ?? { kind: 'usage-unavailable',
      modelCallId: round.report?.modelCallId ?? 'unknown' }
    return true
  }
  return false
}

async function finishDispatch(state: TurnState, details: {
  round: Round; prepared: Prepared; scheduled: Scheduled; repeatedLimit: boolean
}) {
  const { round, prepared, scheduled, repeatedLimit } = details
  if (dispatchedStop(state, round, scheduled)) return false
  const { exhausted, reportReserveReached } = assessExhaustion({
    ...state, ...prepared, round, scheduled, repeatedLimit,
  })
  if (exhausted === undefined) return true
  const reserve = exhausted === 'tokens' && reportReserveReached && !prepared.tokenLimitBeforeDispatch
  const forced = (exhausted !== 'tokens' || reserve)
    && state.bounds.onExhausted !== 'stop' && state.admissionStop() === undefined
  state.reason = forced
    ? await forceAnswer(state.finalContext, exhausted, reserve)
    : { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: false,
      ...(reserve ? { trigger: 'report-reserve' as const } : {}) }
  return true
}

async function dispatchWorkRound(state: TurnState, round: Round, step: number) {
  const prepared = prepareDispatch({ ...state, round })
  const scheduled = await dispatchRoundTools({ ...state, ...prepared, round, step })
  recordDispatch(state, round, prepared, scheduled)
  await state.emit({ type: 'step-end', turn: state.turn, step, trace: round.trace })
  const repeatedLimit = recordProgress(state, round, prepared, scheduled)
  return finishDispatch(state, { round, prepared, scheduled, repeatedLimit })
}

export async function runWorkSteps(state: TurnState) {
  while (state.reason === undefined && state.workSteps() < (state.finalizeUntil ?? state.maxSteps)
    && !state.signal.aborted) {
    if (!await prepareWorkRound(state)) break
    const { round, step, decision } = await requestRound(state)
    if (decision.kind === 'retry') continue
    if (decision.kind === 'stop') { state.reason = decision.reason; break }
    if (!await dispatchWorkRound(state, round, step)) break
  }
}
