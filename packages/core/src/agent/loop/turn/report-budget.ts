import type { ModelCallReport } from '../../../observation/index.ts'
import { budgetTokenTotal, summarizeModelCallUsage } from '../../accounting/ledger.ts'

/**
 * Tokens held back for the answer a spent budget forces.
 *
 * A fixed reserve can be smaller than one request: late in a long run every
 * request carries the whole accumulated context, so the forced answer alone
 * overshoots the budget and leaves nothing for its own retry or re-prompt. A
 * transient failure there then ends a fully spent run with no answer at all.
 * The reserve therefore covers two of the costliest requests seen so far, the
 * answer and one more attempt, but never more than half the budget.
 */
export function reportReserve(configured: number, maxTotalTokens: number, reports: readonly ModelCallReport[]): number {
  return Math.max(configured, Math.min(2 * costliestRequest(reports), Math.floor(maxTotalTokens / 2)))
}

/** Budget tokens of the costliest single request so far: what the next one will likely cost. */
export function costliestRequest(reports: readonly ModelCallReport[]): number {
  let costliest = 0
  for (const report of reports) {
    costliest = Math.max(costliest, budgetTokenTotal(summarizeModelCallUsage([report])) ?? 0)
  }
  return costliest
}
