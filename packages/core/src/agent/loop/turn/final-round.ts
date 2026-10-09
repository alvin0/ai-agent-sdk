import { createUserMessage } from '../../../message/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import type { TraceRef } from '../../trace/trace.ts'
import type { AgentEvent, AgentMaintenanceEvent, ExhaustedBudget, TurnOutcome } from '../types.ts'
import { emitAssistantContent, textOf } from './content.ts'
import { accountingUsageStop } from './usage-stop.ts'
import type { modelRound } from './model-round.ts'
import { requestModelRound, type RequestRetryState } from './request-round.ts'
import { runOptionalHook } from './hooks.ts'
import type { RunTurnOptions } from './types.ts'

export const MAX_FREE_REQUEST_RETRIES = 8

type FinalRound = Awaited<ReturnType<typeof modelRound>>

export type FinalRoundContext = RequestRetryState & {
  options: RunTurnOptions
  signal: AbortSignal
  emit: (event: AgentEvent) => Promise<void>
  emitMaintenance: (event: AgentMaintenanceEvent) => Promise<void>
  root: TraceRef
  turn: number
  steps: number
  retriedRounds: number
  text: string
  modelCallReports: ModelCallReport[]
  position: () => { workStep: number; finalizing: boolean }
  admissionStop: (pendingReport?: ModelCallReport) => TurnOutcome['reason'] | undefined
}

function shouldRetryFinal(ctx: FinalRoundContext, final: FinalRound): boolean {
  return final.finish.kind === 'error' && !final.usageRequired && !ctx.signal.aborted
    && !final.usageUnavailable && ctx.retriedRounds < MAX_FREE_REQUEST_RETRIES
    && ctx.admissionStop(final.report) === undefined
}

export async function retryFinalRound(
  ctx: FinalRoundContext, first: FinalRound, phase: 'final' | 'forced-final',
): Promise<FinalRound> {
  let final = first
  while (shouldRetryFinal(ctx, final)) {
    if (final.finish.kind !== 'error') break
    const decision = await runOptionalHook(ctx.options.hooks?.onRequestError, [{
      turn: ctx.turn, step: ctx.steps + 1, failure: final.finish.failure,
      consecutiveFailures: ctx.consecutiveFailures, retries: ctx.grantedRetries,
      snapshot: ctx.options.history.snapshot(), signal: ctx.signal,
      ...(ctx.options.logger === undefined ? {} : { logger: ctx.options.logger }),
      emit: ctx.emitMaintenance,
    }], ctx.options, { signal: ctx.signal, name: 'onRequestError' })
      .catch((error: unknown) => {
        if (ctx.signal.aborted) return 'fail' as const
        throw error
      })
    if (decision !== 'retry' || ctx.admissionStop(final.report) !== undefined) break
    ctx.grantedRetries++
    if (final.report !== undefined) ctx.modelCallReports.push(final.report)
    ctx.steps++
    ctx.retriedRounds++
    final = await requestModelRound(ctx, {
      options: ctx.options, signal: ctx.signal, emit: ctx.emit,
      emitMaintenance: ctx.emitMaintenance, root: ctx.root, turn: ctx.turn,
      step: ctx.steps + 1, phase, position: ctx.position(),
    })
  }
  return final
}

async function retryEmptyFinalAnswer(ctx: FinalRoundContext, final: FinalRound): Promise<FinalRound> {
  if (final.report !== undefined) ctx.modelCallReports.push(final.report)
  if (final.message !== undefined) {
    ctx.options.history.append({ kind: 'assistant', message: final.message,
      ...final.usage === undefined ? {} : { usage: final.usage } })
  }
  ctx.options.history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'forced-answer-empty' },
    content: [{ type: 'text',
      text: 'Your last reply contained no answer. Tools are disabled now. Write the answer for the user now, in text, '
        + 'from the evidence already gathered, and state what could not be checked.' }],
  }) })
  ctx.steps++
  ctx.retriedRounds++
  return requestModelRound(ctx, {
    options: ctx.options, signal: ctx.signal, emit: ctx.emit,
    emitMaintenance: ctx.emitMaintenance, root: ctx.root, turn: ctx.turn,
    step: ctx.steps + 1, phase: 'forced-final', position: ctx.position(),
  })
}

function finalUsageReason(ctx: FinalRoundContext, final: FinalRound): TurnOutcome['reason'] | undefined {
  if (final.usageRequired) {
    return { kind: 'error', failure: {
      message: 'provider usage is required by the configured run policy', code: 'USAGE_REQUIRED',
    } }
  }
  if (final.usageUnavailable) {
    return accountingUsageStop(ctx.options.accounting) ?? {
      kind: 'usage-unavailable', modelCallId: final.report?.modelCallId ?? 'unknown',
    }
  }
  return undefined
}

function forcedAnswerReason(
  ctx: FinalRoundContext, final: FinalRound, exhausted: ExhaustedBudget, reserveTrigger: boolean,
): TurnOutcome['reason'] {
  if (ctx.signal.aborted || final.finish.kind === 'aborted') return { kind: 'aborted' }
  if (final.finish.kind === 'error') {
    if (final.finish.failure.code === 'INVALID_TOOL_CALL') {
      ctx.text = ''
      return { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: false,
        ...(reserveTrigger ? { trigger: 'report-reserve' as const } : {}) }
    }
    return { kind: 'error', failure: final.finish.failure }
  }
  if (final.finish.kind === 'max-tokens') return { kind: 'max-tokens' }
  const usageReason = finalUsageReason(ctx, final)
  if (usageReason !== undefined) return usageReason
  return { kind: 'budget-exhausted', budget: exhausted, forcedFinalAnswer: ctx.text.trim() !== '',
    ...(reserveTrigger ? { trigger: 'report-reserve' as const } : {}) }
}

async function finishForcedAnswer(
  ctx: FinalRoundContext, final: FinalRound, exhausted: ExhaustedBudget, reserveTrigger: boolean,
): Promise<TurnOutcome['reason']> {
  ctx.steps++
  if (final.report !== undefined) ctx.modelCallReports.push(final.report)
  if (final.message !== undefined) {
    ctx.options.history.append({ kind: 'assistant', message: final.message,
      ...final.usage === undefined ? {} : { usage: final.usage } })
    await ctx.emit({ type: 'assistant-message', message: final.message, trace: final.trace })
    await emitAssistantContent(final, ctx.emit)
    ctx.text = textOf(final.message.content)
  } else ctx.text = ''
  return forcedAnswerReason(ctx, final, exhausted, reserveTrigger)
}

export async function forceAnswer(
  ctx: FinalRoundContext, exhausted: ExhaustedBudget, reserveTrigger: boolean,
): Promise<TurnOutcome['reason']> {
  let final = await retryFinalRound(ctx, await requestModelRound(ctx, {
    options: ctx.options, signal: ctx.signal, emit: ctx.emit,
    emitMaintenance: ctx.emitMaintenance, root: ctx.root, turn: ctx.turn,
    step: ctx.steps + 1, phase: 'forced-final', position: ctx.position(),
  }), 'forced-final')
  const unanswered = (round: FinalRound): boolean => !round.usageRequired && !round.usageUnavailable
    && ((round.finish.kind === 'stop' && textOf(round.message?.content ?? []).trim() === '')
      || (round.finish.kind === 'error' && round.finish.failure.code === 'INVALID_TOOL_CALL'))
  if (unanswered(final) && !ctx.signal.aborted && ctx.retriedRounds < MAX_FREE_REQUEST_RETRIES
    && ctx.admissionStop(final.report) === undefined) final = await retryEmptyFinalAnswer(ctx, final)
  return finishForcedAnswer(ctx, final, exhausted, reserveTrigger)
}

function structuredFinalReason(ctx: FinalRoundContext, final: FinalRound): TurnOutcome['reason'] {
  if (ctx.signal.aborted || final.finish.kind === 'aborted') return { kind: 'aborted' }
  if (final.finish.kind === 'error') return { kind: 'error', failure: final.finish.failure }
  if (final.finish.kind === 'max-tokens') return { kind: 'max-tokens' }
  return finalUsageReason(ctx, final) ?? { kind: 'completed' }
}

export async function finalizeStructuredOutput(ctx: FinalRoundContext): Promise<TurnOutcome['reason']> {
  ctx.options.history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'structured-output-finalizer' },
    content: [{ type: 'text',
      text: 'The process phase is complete. Return the final answer now in the requested output format. '
        + 'Do not call tools.',
    }],
  }) })
  const final = await retryFinalRound(ctx, await requestModelRound(ctx, {
    options: ctx.options, signal: ctx.signal, emit: ctx.emit, emitMaintenance: ctx.emitMaintenance,
    root: ctx.root, turn: ctx.turn, step: ctx.steps + 1, phase: 'final', position: ctx.position(),
  }), 'final')
  ctx.steps++
  if (final.report !== undefined) ctx.modelCallReports.push(final.report)
  if (final.message !== undefined) {
    ctx.options.history.append({ kind: 'assistant', message: final.message,
      ...final.usage === undefined ? {} : { usage: final.usage } })
    await ctx.emit({ type: 'assistant-message', message: final.message, trace: final.trace })
    await emitAssistantContent(final, ctx.emit)
    ctx.text = textOf(final.message.content)
  }
  return structuredFinalReason(ctx, final)
}
