import type { AgentEvent, TurnOutcome } from '../types.ts'
import type { ModelRoundPhase, RunTurnOptions } from './types.ts'
import type { modelRound } from './model-round.ts'
import { emitAssistantContent, textOf } from './content.ts'
import { accountingUsageStop } from './usage-stop.ts'

type Round = Awaited<ReturnType<typeof modelRound>>

export function roundPhase(options: RunTurnOptions, dedicatedFinalOutput: boolean): ModelRoundPhase {
  if (dedicatedFinalOutput) return 'process'
  return options.outputFormat?.type === 'json_schema' ? 'final' : 'standard'
}

export function roundUsageStop(options: RunTurnOptions, round: Round): TurnOutcome['reason'] | undefined {
  const mandatory = accountingUsageStop(options.accounting)
  if (mandatory !== undefined) return mandatory
  if (round.usageRequired) return { kind: 'error', failure: {
    message: 'provider usage is required by the configured run policy', code: 'USAGE_REQUIRED',
  } }
  if (round.usageUnavailable) return { kind: 'usage-unavailable', modelCallId: round.report?.modelCallId ?? 'unknown' }
  return undefined
}

export async function commitModelRound(ctx: {
  options: RunTurnOptions; emit: (event: AgentEvent) => Promise<void>; text: string
}, round: Round): Promise<string> {
  if (round.message === undefined) return round.finish.kind === 'stop' ? '' : ctx.text
  ctx.options.history.append({
    kind: 'assistant', message: round.message,
    ...round.finish.kind === 'aborted' ? { interrupted: true as const } : {},
    ...round.usage === undefined ? {} : { usage: round.usage },
  })
  await ctx.emit({ type: 'assistant-message', message: round.message, trace: round.trace })
  await emitAssistantContent(round, ctx.emit)
  // Failed or interrupted reasoning must not erase an earlier answer.
  const roundText = textOf(round.message.content)
  if (roundText.trim() !== '' || (round.finish.kind !== 'error' && round.finish.kind !== 'aborted')) return roundText
  return ctx.text
}
