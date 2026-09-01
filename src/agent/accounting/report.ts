import type {
  GenerateOptions,
  ModelCallReport,
  ObservationDeliverySummary,
  OperationStatus,
  SafeErrorRecord,
  TraceId,
  UsageCounters,
} from '@ai-agent-sdk/core'

export interface UsageCoverageSummary {
  readonly logicalCalls: number
  readonly attempts: number
  readonly complete: number
  readonly partial: number
  readonly estimated: number
  readonly missing: number
  readonly notApplicable: number
  readonly possiblyBilledAttemptsWithoutUsage: number
}

export interface RunUsageReport {
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly coverage: UsageCoverageSummary
  readonly authoritative: boolean
}

export interface RunOperationCounts {
  readonly total: number
  readonly success: number
  readonly error: number
  readonly aborted: number
  readonly rejected: number
  readonly unknown: number
}

export type TrackedOperationKind =
  | 'turn'
  | 'model-call'
  | 'provider-attempt'
  | 'tool'
  | 'compaction'
  | 'hook'
  | 'user-input'
  | 'skill'
  | 'memory'
  | 'credential'
  | 'integration'

export interface RunReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly status: OperationStatus
  readonly usage: RunUsageReport
  readonly modelCalls: readonly ModelCallReport[]
  readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>
  readonly errors: readonly SafeErrorRecord[]
  readonly delivery: ObservationDeliverySummary
}

export interface UsagePolicy {
  readonly onMissing?: 'warn' | 'estimate' | 'fail'
  readonly estimator?: UsageEstimator
}

export interface UsageEstimator {
  readonly id: string
  estimate(input: UsageEstimationInput): UsageCounters | Promise<UsageCounters>
}

/** Local-only estimator input. It is never retained in the ledger or exported. */
export interface UsageEstimationInput {
  readonly runId: string
  readonly modelCallId: string
  readonly provider: string
  readonly model: string
  readonly request: GenerateOptions
  readonly report: ModelCallReport
}

export interface RunLedgerLimits {
  readonly maxModelCalls?: number
  readonly maxAttemptsPerCall?: number
  readonly maxToolCalls?: number
  readonly maxSerializedBytes?: number
}
