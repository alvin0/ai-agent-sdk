import type { ModelCallReport } from '../../../observation/index.ts'
import type { UserMessage } from '../../../message/index.ts'
import type { TraceRef } from '../../trace/trace.ts'
import { authoritativeTokenUsage, summarizeModelCallUsage } from '../../accounting/ledger.ts'
import type { TurnEndDecision, TurnOutcome } from '../types.ts'
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

function appendContinuation(options: RunTurnOptions, decision: TurnEndDecision | void): void {
  if (decision?.kind !== 'continue') return
  // Validate the whole batch before appending anything. A host continuation is
  // context, never a new human request or a fresh accounting/budget scope.
  const messages: unknown = decision.messages
  if (!Array.isArray(messages) || messages.some(message => !isAppUserMessage(message))) {
    throw new TypeError('Turn continuation requires app-sourced user messages')
  }
  // One batch: a history limit hit by a later message must not leave earlier ones appended.
  options.history.appendBatch((messages as readonly UserMessage[]).map(message => ({
    event: { kind: 'user' as const, message },
  })))
}

function isAppUserMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<UserMessage>
  return message.role === 'user' && typeof message.source === 'object' && message.source !== null
    && message.source.kind === 'app'
}

async function continueAfterHook(
  options: RunTurnOptions, signal: AbortSignal,
  context: { outcome: TurnOutcome; canContinue: boolean; phase: 'onTurnEnd' | 'beforeCompletion' },
): Promise<'continue' | 'end' | 'yield'> {
  const { outcome, canContinue, phase } = context
  const entriesBeforeHook = options.history.entries().length
  const decision = await runOptionalHook(options.hooks?.[phase], [{
    outcome, snapshot: options.history.snapshot(), canContinue,
  }], options, { signal: signal.aborted ? new AbortController().signal : signal, name: phase })
  if (signal.aborted) return 'end'
  if (decision?.kind === 'yield') return 'yield'
  if (!canContinue) return 'end'
  appendContinuation(options, decision)
  // Queued input is delivered only when no hook append already continues the turn.
  return (options.history.entries().length > entriesBeforeHook || deliverQueuedInput(options.history))
    ? 'continue' : 'end'
}

export function continueAfterTurnHook(
  options: RunTurnOptions, signal: AbortSignal, outcome: TurnOutcome, canContinue: boolean,
): Promise<'continue' | 'end' | 'yield'> {
  return continueAfterHook(options, signal, { outcome, canContinue, phase: 'onTurnEnd' })
}

export function continueBeforeCompletion(options: RunTurnOptions, signal: AbortSignal, outcome: TurnOutcome) {
  return continueAfterHook(options, signal, { outcome, canContinue: true, phase: 'beforeCompletion' })
}

export function turnOutcomeStatus(outcome: TurnOutcome): 'error' | 'aborted' | 'success' {
  if (outcome.reason.kind === 'error') return 'error'
  return outcome.reason.kind === 'aborted' ? 'aborted' : 'success'
}
