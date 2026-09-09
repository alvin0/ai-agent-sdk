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

/** Metadata-only error shape safe for default diagnostics and public support artifacts. */
export interface SupportSafeError {
  readonly code: string
  readonly stage: string
  readonly message: string
  readonly provider?: string
  readonly route?: string
  readonly origin?: string
  readonly status?: number
  readonly requestId?: string
  readonly retryable?: boolean
  readonly dispatchState?: 'not-sent' | 'sent' | 'unknown'
  readonly usageCoverage: UsageCoverageSummary
  readonly possiblyBilledAttemptsWithoutUsage: number
}

export const NOT_APPLICABLE_USAGE_COVERAGE: UsageCoverageSummary = Object.freeze({
  logicalCalls: 0, attempts: 0, complete: 0, partial: 0,
  estimated: 0, missing: 0, notApplicable: 0,
  possiblyBilledAttemptsWithoutUsage: 0,
})
