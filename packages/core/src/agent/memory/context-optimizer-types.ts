import type { HistorySnapshot } from '../history/types.ts'
import type { SpillStore } from '../tool/output-budget.ts'
import type { EvidenceReducer } from '../tool/evidence-reducer.ts'

export interface ContextMilestone {
  readonly id: string
  /** Inclusive append-only sequence boundary, captured after the completed step. */
  readonly throughSeq: number
  /** Host-verified state, including decisions and unresolved constraints needed later. */
  readonly summary: string
  readonly remainingTurns: number
  /** Same cost units as historyTokenCost; include input/output and summary-model price. */
  readonly compactionCost: number
  readonly historyTokenCost?: number
}
export interface ContextOptimizerOptions {
  /** Mount the returned retrievalTool in the same session. Use a store scoped to that session. */
  readonly store: SpillStore
  readonly observationThresholdBytes?: number
  readonly summaryBytes?: number
  readonly fullRequests?: number
  readonly maxObservations?: number
  readonly maxMilestones?: number
  /** Persist raw snapshots locally/durably before a milestone projection is accepted. */
  readonly archive?: (snapshot: HistorySnapshot, milestone: ContextMilestone, signal: AbortSignal) => Promise<void>
  readonly reducer?: EvidenceReducer
  /** Explicitly identify logs and their authoritative outcome; core does not guess exit status. */
  readonly log?: (toolName: string, text: string) => {
    readonly status: 'pass' | 'fail' | 'unknown'; readonly requiredLines?: readonly number[]
  } | undefined
  readonly reductionThresholdBytes?: number
}
export interface ContextOptimizationMetrics {
  readonly packedObservations: number
  readonly verifiedReductions: number
  readonly rejectedReductions: number
  readonly compactedMilestones: number
  readonly skippedMilestones: number
  /** Estimate of payload tokens avoided across prepared requests; never billing usage. */
  readonly estimatedTokensSaved: number
}
export type MutableOptimizationMetrics = {
  -readonly [Key in keyof ContextOptimizationMetrics]: ContextOptimizationMetrics[Key]
}
