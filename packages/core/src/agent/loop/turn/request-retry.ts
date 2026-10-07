import type { TurnOutcome } from '../types.ts'
import type { modelRound } from './model-round.ts'
import { accountingUsageStop } from './usage-stop.ts'
import { runOptionalHook } from './hooks.ts'
import { MAX_FREE_REQUEST_RETRIES, type FinalRoundContext } from './final-round.ts'

type Round = Awaited<ReturnType<typeof modelRound>>
type RetryContext = {
  finalContext: FinalRoundContext; workSteps: () => number; limit: number; commitRound: () => Promise<void>
}

async function requestRetryDecision(ctx: FinalRoundContext, round: Round, step: number): Promise<unknown> {
  if (round.finish.kind !== 'error') return 'fail'
  return runOptionalHook(ctx.options.hooks?.onRequestError, [{
    turn: ctx.turn, step, failure: round.finish.failure, snapshot: ctx.options.history.snapshot(),
    signal: ctx.signal, ...(ctx.options.logger === undefined ? {} : { logger: ctx.options.logger }),
    emit: ctx.emitMaintenance,
  }], ctx.options, { signal: ctx.signal, name: 'onRequestError' })
    .catch((error: unknown) => {
      if (ctx.signal.aborted) return 'fail' as const
      throw error
    })
}

export async function retryErroredRound(
  retry: RetryContext, round: Round, step: number,
): Promise<TurnOutcome['reason'] | 'retry'> {
  const ctx = retry.finalContext
  const admission = ctx.admissionStop()
  if (admission !== undefined) { await retry.commitRound(); return admission }
  const decision = await requestRetryDecision(ctx, round, step)
  const maintenance = accountingUsageStop(ctx.options.accounting)
  if (maintenance !== undefined) {
    await retry.commitRound()
    return ctx.signal.aborted ? { kind: 'aborted' } : maintenance
  }
  if (decision === 'retry' && !ctx.signal.aborted) {
    if (ctx.retriedRounds < MAX_FREE_REQUEST_RETRIES) ctx.retriedRounds++
    if (retry.workSteps() < retry.limit) return 'retry'
  }
  await retry.commitRound()
  if (ctx.signal.aborted) return { kind: 'aborted' }
  if (round.finish.kind !== 'error') throw new Error('request retry requires a failed model round')
  return { kind: 'error', failure: round.finish.failure }
}
