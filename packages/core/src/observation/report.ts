import type { StreamChunk } from '../stream/chunk.ts'
import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import type { CorrelationContext, ObservationRunScope, SpanId, TraceId } from './context.ts'
import type { OperationStatus, SafeErrorRecord } from './event.ts'
import type { ObservationDeliverySummary, ObservationPort } from './port.ts'
import type { AttemptUsageReport, UsageCounters, UsageCoverage } from './usage.ts'

export interface ModelCallReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly modelCallId: string
  readonly spanId: SpanId
  readonly provider: string
  readonly model: string
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly finishReason?: string
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly attempts: readonly AttemptUsageReport[]
  readonly possiblyBilledAttemptsWithoutUsage: number
  readonly authoritative: boolean
  readonly delivery: ObservationDeliverySummary
  readonly error?: SafeErrorRecord
}

export interface ModelCallHandle extends AsyncIterable<StreamChunk> {
  readonly runId: string
  readonly modelCallId: string
  readonly report: Promise<ModelCallReport>
}

export interface ModelInvocationContext {
  readonly observation?: ObservationPort
  readonly correlation?: Partial<CorrelationContext>
  readonly terminalCheckpointOwner?: 'model-call' | 'agent-run'
  /** Shared sequence/monotonic scope when this call belongs to a larger agent run. */
  readonly scope?: ObservationRunScope
}

export const OBSERVATION_ERROR_CODES = Object.freeze({
  AUDIT_UNAVAILABLE: 'OBSERVABILITY_AUDIT_UNAVAILABLE',
  CAPTURE_REJECTED: 'OBSERVABILITY_CAPTURE_REJECTED',
  PROCESSOR_FAILED: 'OBSERVABILITY_PROCESSOR_FAILED',
  EXPORT_FAILED: 'OBSERVABILITY_EXPORT_FAILED',
  FLUSH_TIMEOUT: 'OBSERVABILITY_FLUSH_TIMEOUT',
  JOURNAL_CORRUPT: 'OBSERVABILITY_JOURNAL_CORRUPT',
  JOURNAL_IO: 'OBSERVABILITY_JOURNAL_IO',
  BROWSER_QUOTA: 'OBSERVABILITY_BROWSER_QUOTA',
  OTEL_PROVIDER_UNCONFIGURED: 'OTEL_PROVIDER_UNCONFIGURED',
  OPERATION_TERMINAL_MISSING: 'OPERATION_TERMINAL_MISSING',
  LEDGER_LIMIT_EXCEEDED: 'LEDGER_LIMIT_EXCEEDED',
  USAGE_MISSING: 'USAGE_MISSING',
  USAGE_REQUIRED: 'USAGE_REQUIRED',
  USAGE_INVALID: 'USAGE_INVALID',
  USAGE_COUNTER_OVERFLOW: 'USAGE_COUNTER_OVERFLOW',
} as const)

export class ModelCallObservationError extends AgentSdkError {
  readonly runId: string
  readonly modelCallId: string
  readonly traceId: TraceId
  readonly report: ModelCallReport

  constructor(message: string, report: ModelCallReport, options?: ErrorOptions) {
    super(message, OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE, options)
    this.name = 'ModelCallObservationError'
    this.runId = report.runId
    this.modelCallId = report.modelCallId
    this.traceId = report.traceId
    this.report = report
  }
}
