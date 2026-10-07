import {
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'
import {
  OBSERVATION_ERROR_CODES,
  type ObservationPort,
  type OperationStatus,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'
import {
  type ObservationContentPolicy,
  type ObservationProcessor,
} from '@alvin0/ai-agent-sdk-core/observability'

export const OTEL_SEMANTIC_CONVENTIONS_COMMIT = '5ca9052bc796ef1e497200b1d558fd87a201f335'

export class OpenTelemetryBridgeError extends Error {
  override readonly name = 'OpenTelemetryBridgeError'
  readonly code = OBSERVATION_ERROR_CODES.OTEL_PROVIDER_UNCONFIGURED
}

export interface OpenTelemetryBridgeOptions {
  readonly tracer: Tracer
  readonly meter: Meter
  readonly logger?: OpenTelemetryLogger
  /** Exact prompt/completion span attributes remain disabled unless this is explicitly `full`. */
  readonly content?: ObservationContentPolicy
  readonly onDiagnostic?: (error: SafeErrorRecord) => void
}

export interface OpenTelemetryBridge {
  readonly openSpan: ObservationPort['openSpan']
  readonly processor: ObservationProcessor
  diagnostics(): readonly SafeErrorRecord[]
}

export interface OpenTelemetryLogger {
  emit(record: OpenTelemetryLogRecord): void
  enabled?(options?: OpenTelemetryLogEnabledOptions): boolean
}

export interface OpenTelemetryLogRecord {
  readonly context?: Context
  readonly [key: string]: unknown
}

export interface OpenTelemetryLogEnabledOptions {
  readonly context?: Context
  readonly [key: string]: unknown
}

export interface SpanState {
  readonly span: Span
  readonly context: Context
  readonly spanContext: SpanContext
  readonly sdkSpanId: string
  endRequested?: { readonly status: OperationStatus; readonly endedAt: string }
  terminalSeen: boolean
  finished: boolean
}

export interface MetricSinks {
  readonly sdkModelDuration: Histogram
  readonly sdkProviderDuration: Histogram
  readonly sdkToolDuration: Histogram
  readonly sdkTokenUsage: Counter
  readonly sdkUsageCoverage: Counter
  readonly sdkProviderRetry: Counter
  readonly genAiClientDuration: Histogram
  readonly genAiTokenUsage: Histogram
  readonly genAiAgentDuration: Histogram
  readonly genAiToolDuration: Histogram
}
