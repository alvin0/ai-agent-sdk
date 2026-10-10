import type { ModelCallReport } from '../../../observation/index.ts'
import type { TraceRef } from '../../trace/trace.ts'
import { authoritativeTokenUsage, summarizeModelCallUsage } from '../../accounting/ledger.ts'
import type { TurnOutcome } from '../types.ts'
import type { RunTurnOptions } from './types.ts'
import { deliverQueuedInput } from './model-request-boundary.ts'
import { runOptionalHook } from './hooks.ts'

export function buildTurnOutcome(input: {
  reason: TurnOutcome['reason']; text: string; steps: number; toolCalls: number
  modelCallReports: ModelCallReport[]; traceId: TraceRef['traceId']
}): TurnOutcome {
  const usageReport = summarizeModelCallUsage(input.modelCallReports)
  const usage = authoritativeTokenUsage(usageReport)
  return { reason: input.reason, text: input.text, steps: input.steps, toolCalls: input.toolCalls,
    traceId: input.traceId, usageReport, ...usage === undefined ? {} : { usage } }
}

export async function continueAfterTurnHook(
  options: RunTurnOptions, signal: AbortSignal, outcome: TurnOutcome, canContinue: boolean,
): Promise<boolean> {
  const entriesBeforeHook = options.history.entries().length
  await runOptionalHook(options.hooks?.onTurnEnd, [{
    outcome, snapshot: options.history.snapshot(), canContinue,
  }], options, { signal: signal.aborted ? new AbortController().signal : signal, name: 'onTurnEnd' })
  // Queued input is delivered only when no hook append already continues the turn.
  return canContinue && !signal.aborted
    && (options.history.entries().length > entriesBeforeHook || deliverQueuedInput(options.history))
}

export function turnOutcomeStatus(outcome: TurnOutcome): 'error' | 'aborted' | 'success' {
  if (outcome.reason.kind === 'error') return 'error'
  return outcome.reason.kind === 'aborted' ? 'aborted' : 'success'
}
