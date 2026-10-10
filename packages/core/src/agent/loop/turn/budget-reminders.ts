import { createUserMessage } from '../../../message/index.ts'
import type { ModelCallReport } from '../../../observation/index.ts'
import { budgetTokenTotal, summarizeModelCallUsage } from '../../accounting/ledger.ts'
import type { TurnBounds } from '../types.ts'
import type { RunTurnOptions } from './types.ts'

export type BudgetReminderContext = {
  options: RunTurnOptions; bounds: TurnBounds; maxTotalTokens: number; maxSteps: number
  modelCallReports: ModelCallReport[]; tokenRemindersSent: number; stepReminderSent: boolean
  finalizeUntil: number | undefined; workSteps: () => number
}

export function remindTurnBudgets(ctx: BudgetReminderContext): void {
    const usedTokens = budgetTokenTotal(summarizeModelCallUsage(ctx.modelCallReports))
    if (ctx.bounds.maxTotalTokens !== 'auto' && usedTokens !== undefined) {
      const crossed = [0.5, 0.75, 0.9].filter(ratio => usedTokens >= ctx.maxTotalTokens * ratio).length
      if (crossed > ctx.tokenRemindersSent) {
        ctx.tokenRemindersSent = crossed
        const remaining = Math.max(0, ctx.maxTotalTokens - usedTokens)
        ctx.options.history.append({ kind: 'user', message: createUserMessage({
          source: { kind: 'app', producer: 'tool-loop-token-guard' },
          content: [{ type: 'text',
            text: `Token budget: ${remaining} of ${ctx.bounds.maxTotalTokens} aggregate tokens `
            + `remain. Each request also spends input tokens on the accumulated context. `
            + (crossed >= 2 ? 'Stop broad exploration. ' : 'Prioritize outstanding verification and reporting. ')
            + 'Reserve capacity for the required self-check, honest todo reconciliation and '
            + 'substantive final report. State unavailable evidence and unfinished work; do '
            + 'not claim it is verified. No extra model call is allowed after the hard token '
            + 'limit.',
          }],
        }) })
      }
    }
    // Leave time to reconcile a plan and submit a result before the final
    // tools-disabled summary. Tool-call reminders do not cover step limits.
    if (!ctx.stepReminderSent && ctx.finalizeUntil === undefined
      && ctx.workSteps() > 0 && ctx.maxSteps - ctx.workSteps() <= 2) {
      ctx.stepReminderSent = true
      ctx.options.history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'tool-loop-step-guard' },
        content: [{ type: 'text', text:
          `${ctx.maxSteps - ctx.workSteps()} work steps remain. Finish essential `
          + `verification, update any task list honestly, and submit the result if required. `
          + `Summarize findings, evidence, and unfinished work; do not start new exploration.`,
        }],
      }) })
    }

}
