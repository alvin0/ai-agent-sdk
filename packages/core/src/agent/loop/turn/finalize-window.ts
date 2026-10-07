import type { Message } from '../../../message/index.ts'
import type { ExhaustedBudget, TurnOutcome } from '../types.ts'
import type { RunTurnOptions } from './types.ts'
import { hasQueuedInput } from './model-request-boundary.ts'

type FinalizableReason = Extract<TurnOutcome['reason'], { kind: 'budget-exhausted' } | { kind: 'completed' }>
type WindowContext = {
  options: RunTurnOptions; reason: TurnOutcome['reason'] | undefined; text: string
  finalizeUntil: number | undefined; finalizeSteps: number; workStep: number; maxSteps: number
  signal: AbortSignal; admissionStop: () => TurnOutcome['reason'] | undefined
}

function eligibleReason(ctx: WindowContext): FinalizableReason | undefined {
  if (ctx.reason?.kind === 'budget-exhausted') return ctx.reason.forcedFinalAnswer ? ctx.reason : undefined
  if (ctx.reason?.kind === 'completed' && ctx.workStep >= ctx.maxSteps) return ctx.reason
  return undefined
}

function canOpenWindow(ctx: WindowContext): boolean {
  return ctx.finalizeUntil === undefined && ctx.options.finalize !== undefined && ctx.finalizeSteps > 0
    && ctx.text.trim() !== '' && !ctx.signal.aborted && ctx.admissionStop() === undefined
    && !hasQueuedInput(ctx.options.history)
}

export function openFinalizeWindow(ctx: WindowContext): {
  origin: FinalizableReason; budget: ExhaustedBudget; message: Message | undefined; until: number
} | undefined {
  const reason = eligibleReason(ctx)
  if (reason === undefined || !canOpenWindow(ctx)) return undefined
  const prompt = ctx.options.finalize?.prompt({ text: ctx.text, reason })
  if (prompt === undefined) return undefined
  ctx.options.history.append({ kind: 'user', message: prompt })
  return { origin: reason, budget: reason.kind === 'budget-exhausted' ? reason.budget : 'steps',
    message: ctx.options.history.messages().findLast(message => message.role === 'assistant'),
    until: ctx.workStep + ctx.finalizeSteps,
  }
}
