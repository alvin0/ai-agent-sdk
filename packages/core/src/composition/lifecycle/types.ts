export const RUNTIME_OPERATION_KINDS = Object.freeze([
  'agent-run', 'model-catalog', 'manual-compaction', 'team-operation',
] as const)

export type RuntimeOperationKind = typeof RUNTIME_OPERATION_KINDS[number]

export interface RuntimeOperationCloseSummary {
  readonly kind: RuntimeOperationKind
  readonly activeAtClose: number
  readonly aborted: number
  readonly settled: number
  readonly unsettled: number
}

export interface QuiescenceReport {
  readonly quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  readonly deadlineReached: boolean
  readonly activeRunsAtClose: number
  readonly abortedRuns: number
  readonly unsettledRuns: number
  readonly operations: readonly RuntimeOperationCloseSummary[]
}

export interface OperationLease {
  readonly signal: AbortSignal
  readonly whenSealed: Promise<void>
  /** The callback must commit synchronously and must not perform user code or await. */
  publish(commit: () => void): boolean
  settle(): void
}

export interface OperationOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}
