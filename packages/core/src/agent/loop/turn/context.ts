import { createUserMessage } from '../../../message/index.ts'
import { ContextSectionRuntime } from '../../context/section.ts'
import { runHook } from './hooks.ts'
import type { RunTurnOptions } from './types.ts'

export function createBudgetNoticeAppender(options: RunTurnOptions): (text: string) => void {
  let budgetNoticeSeq: number | undefined
  return (text: string): void => {
    const message = createUserMessage({
      source: { kind: 'app', producer: 'tool-loop-budget-guard' },
      content: [{ type: 'text', text }],
    })
    const previous = budgetNoticeSeq
    // Replacing is best-effort. Compaction can shadow the earlier notice
    // between steps, and a replace whose target is no longer on the surface is
    // rejected — which must cost the model a reminder, never the turn.
    if (previous !== undefined) {
      try {
        budgetNoticeSeq = options.history.append(
          { kind: 'user', message },
          { op: 'replace', from: previous, to: previous, targets: [previous] },
        ).seq
        return
      } catch {
        budgetNoticeSeq = undefined
      }
    }
    budgetNoticeSeq = options.history.append({ kind: 'user', message }).seq
  }

}

export function createTurnContextSections(
  options: RunTurnOptions, signal: AbortSignal,
): ContextSectionRuntime | undefined {
  return options.contextSections === undefined || options.contextSections.length === 0
    ? undefined
    : new ContextSectionRuntime({
      sections: options.contextSections,
      history: options.history,
      ...options.logger === undefined ? {} : { logger: options.logger },
      guard: (pending, name) => runHook(pending, options, signal, { name }),
      scope: { agentId: options.trace?.agentId, conversationId: options.trace?.conversationId },
    })

}
