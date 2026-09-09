import type { StreamChunk } from '../stream/chunk.ts'
import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import type { CorrelationContext, ObservationRunScope, SpanId, TraceId } from './context.ts'
import type { ObservationResource, OperationStatus, SafeErrorRecord } from './event.ts'
import type { ObservationDeliverySummary, ObservationPort } from './port.ts'
import type { AttemptUsageReport, DispatchState, UsageCounters, UsageCoverage } from './usage.ts'
import type { SdkLogger } from '../logging/types.ts'

export interface ModelCallReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly modelCallId: string
  readonly spanId: SpanId
  readonly provider: string
  /** Provider family independently of the selected route, when installed as a plugin. */
  readonly providerFamily?: string
  /** Exact plugin installation that owned the selected route. */
  readonly providerPluginId?: string
  readonly model: string
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly finishReason?: string
  /** Logical dispatch state, retained even when an adapter did not expose physical attempts. */
  readonly dispatchState?: DispatchState
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

/** Safe facts known immediately before one physical provider dispatch. */
export interface StartProviderAttemptInput {
  readonly provider: string
  readonly model: string
  readonly method: string
  /** Scheme, host, and explicit non-default port only; never a path or query. */
  readonly origin: string
}

/** Terminal facts supplied by a transport after exactly one dispatch boundary. */
export interface EndProviderAttemptInput {
  readonly status: OperationStatus
  readonly dispatchState: DispatchState
  readonly reported?: UsageCounters
  readonly httpStatus?: number
  readonly providerRequestId?: string
  /** Must already be safe for support reports; raw response bodies are forbidden. */
  readonly error?: SafeErrorRecord
}

/** Safe scheduling facts between two physical provider attempts. */
export interface ProviderRetryScheduledInput {
  readonly nextAttemptNumber: number
  readonly delayMs: number
  readonly failureCode: string
}

/** One physical provider-attempt lifecycle owned by the model-call handle. */
export interface ProviderAttemptHandle {
  readonly attemptId: string
  readonly attemptNumber: number
  readonly traceparent: string
  end(input: EndProviderAttemptInput): AttemptUsageReport
}

export interface ModelInvocationContext {
  readonly observation?: ObservationPort
  /** Safe SDK/service/runtime identity copied onto nested provider operations. */
  readonly resource?: ObservationResource
  readonly correlation?: Partial<CorrelationContext>
  readonly terminalCheckpointOwner?: 'model-call' | 'agent-run'
  /** Shared sequence/monotonic scope when this call belongs to a larger agent run. */
  readonly scope?: ObservationRunScope
  /** Always present on AgentRuntime calls; optional for preserved low-level callers. */
  readonly logger?: SdkLogger
  /** Declares that the adapter will report the real network boundary itself. */
  readonly declareProviderAttemptAccounting?: () => void
  /**
   * Internal transport accounting boundary. HTTP providers call this immediately
   * before dispatch; audit mode may reject before any network request is invoked.
   */
  readonly startProviderAttempt?: (
    input: StartProviderAttemptInput,
    signal?: AbortSignal,
  ) => Promise<ProviderAttemptHandle>
  readonly recordProviderRetry?: (input: ProviderRetryScheduledInput) => void
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
