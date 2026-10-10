import type { TurnOutcome } from '../types.ts'
import type { modelRound } from './model-round.ts'
import { commitModelRound } from './round-commit.ts'
import { retryErroredRound } from './request-retry.ts'
import { finalizeStructuredOutput, type FinalRoundContext } from './final-round.ts'
import { accountingUsageStop } from './usage-stop.ts'
import { warnDuplicateToolIds } from './tool-warnings.ts'

type Round = Awaited<ReturnType<typeof modelRound>>
type Decision = { kind: 'dispatch' } | { kind: 'retry' }
  | { kind: 'stop'; reason: TurnOutcome['reason'] | undefined }
type DecisionContext = {
  finalContext: FinalRoundContext; workSteps: () => number; limit: number
  usageStop: TurnOutcome['reason'] | undefined; dedicatedFinalOutput: boolean
}

function earlyRoundStop(ctx: DecisionContext, round: Round): Decision | undefined {
  if (ctx.finalContext.signal.aborted || round.finish.kind === 'aborted') {
    return { kind: 'stop', reason: { kind: 'aborted' } }
  }
  if (round.finish.kind === 'error' && ctx.usageStop !== undefined) {
    return { kind: 'stop', reason: { kind: 'error', failure: round.finish.failure } }
  }
  if (round.usageRequired && (round.calls.length === 0 || ctx.finalContext.options.tools === undefined)) {
    return { kind: 'stop', reason: ctx.usageStop }
  }
  return undefined
}

function emptyRoundUsageStop(ctx: DecisionContext, round: Round): Decision | undefined {
  const final = ctx.finalContext
  if (round.calls.length === 0 && round.usageUnavailable) {
    return { kind: 'stop', reason: accountingUsageStop(final.options.accounting) ?? {
      kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown',
    } }
  }
  return undefined
}

async function finalRoundDecision(ctx: DecisionContext, round: Round): Promise<Decision> {
  const final = ctx.finalContext
  if (round.finish.kind === 'max-tokens' && !round.usageRequired) {
    return { kind: 'stop', reason: { kind: 'max-tokens' } }
  }
  const usage = emptyRoundUsageStop(ctx, round)
  if (usage !== undefined) return usage
  if (round.calls.length === 0 && ctx.dedicatedFinalOutput) {
    const admission = final.admissionStop()
    return { kind: 'stop', reason: admission ?? await finalizeStructuredOutput(final) }
  }
  warnDuplicateToolIds(final.options, round.droppedDuplicateCalls)
  if (round.calls.length === 0 || final.options.tools === undefined) {
    return { kind: 'stop', reason: { kind: 'completed' } }
  }
  return { kind: 'dispatch' }
}

export async function processModelRound(ctx: DecisionContext, round: Round, step: number): Promise<Decision> {
  const final = ctx.finalContext
  const commitRound = async (): Promise<void> => {
    final.text = await commitModelRound({ options: final.options, emit: final.emit, text: final.text }, round)
  }
  // Failed retry candidates stay out of history until their request is terminal.
  const retryCandidate = round.finish.kind === 'error' && !round.usageRequired
    && ctx.usageStop === undefined && !final.signal.aborted
  if (!retryCandidate) await commitRound()
  const early = earlyRoundStop(ctx, round)
  if (early !== undefined) return early
  if (round.finish.kind === 'error' && !round.usageRequired) {
    const retry = await retryErroredRound({
      finalContext: final, workSteps: ctx.workSteps, limit: ctx.limit, commitRound,
    }, round, step)
    return retry === 'retry' ? { kind: 'retry' } : { kind: 'stop', reason: retry }
  }
  return finalRoundDecision(ctx, round)
}
