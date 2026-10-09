import { createMessage, type Message } from '../../../message/index.ts'
import type { TraceRef } from '../../trace/trace.ts'
import type { AgentEvent, TurnOutcome } from '../types.ts'
import type { RunTurnOptions } from './types.ts'

type FinalizedAnswer = {
  finalizePromptSeq: number | undefined
  options: RunTurnOptions; emit: (event: AgentEvent) => Promise<void>; root: TraceRef
  reason: TurnOutcome['reason']; text: string; forcedText: string; forcedMessage: Message | undefined
  finalizeOrigin: Extract<TurnOutcome['reason'], { kind: 'budget-exhausted' } | { kind: 'completed' }>
}

async function restoreForcedMessage(ctx: FinalizedAnswer): Promise<void> {
  const last = ctx.options.history.messages().findLast(message => message.role === 'assistant')
  if (ctx.forcedMessage === undefined || last?.id === ctx.forcedMessage.id) return
  const restored = createMessage({ role: 'assistant', content: ctx.forcedMessage.content,
    source: ctx.forcedMessage.source })
  const windowStart = ctx.finalizePromptSeq ?? Infinity
  const superseded = ctx.options.history.surface()
    .filter(node => node.seq > windowStart && node.message.source.kind !== 'user').map(node => node.seq)
  ctx.options.history.append({ kind: 'assistant', message: restored }, superseded.length === 0 ? undefined
    : { op: 'replace', from: Math.min(...superseded), to: Math.max(...superseded), targets: superseded })
  await ctx.emit({ type: 'assistant-message', message: restored, trace: ctx.root })
}

export async function preserveFinalizedAnswer(ctx: FinalizedAnswer): Promise<{
  text: string; reason: TurnOutcome['reason']
}> {
  const confirmed = ctx.reason.kind === 'completed' && ctx.text.trim() !== ''
    && ctx.options.finalize?.confirmed() === true
  if (!confirmed) await restoreForcedMessage(ctx)
  return { text: confirmed ? ctx.text : ctx.forcedText,
    reason: ctx.reason.kind === 'aborted' ? ctx.reason : ctx.finalizeOrigin }
}
