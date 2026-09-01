import type {
  CaptureReceipt,
  CorrelationContext,
  JsonObject,
  ModelInvocationContext,
  ObservationBoundary,
  ObservationEvent,
  ObservationPort,
  ObservationResource,
  SafeErrorRecord,
} from '@ai-agent-sdk/core'

export type ObservationContentPolicy = 'none' | 'metadata' | 'redacted' | 'full'
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ObservationBatch {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly createdAt: string
  readonly events: readonly ObservationEvent[]
}

export interface ExportAck {
  readonly batchId: string
  readonly accepted: boolean
  readonly retryable: boolean
}

export interface ObservationExporter {
  readonly id: string
  /** Boundaries this exporter can honestly reach. Omission means memory-only. */
  readonly supportedBoundaries?: readonly ObservationBoundary[]
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  shutdown?(signal: AbortSignal): Promise<void>
}

export interface ObservationExporterRegistration {
  readonly exporter: ObservationExporter
  readonly requirement: 'required' | 'best-effort'
  readonly boundary: ObservationBoundary
}

export interface FlushResult {
  readonly complete: boolean
  readonly exportedEvents: number
  readonly pendingEvents: number
  readonly rejectedCritical: number
  readonly timedOut: boolean
}

export interface ObservationHealthSnapshot {
  readonly state: 'disabled' | 'healthy' | 'degraded' | 'failed' | 'closed'
  readonly queuedEvents: number
  readonly queuedBytes: number
  readonly accepted: number
  readonly exported: number
  readonly droppedVerbose: number
  readonly droppedNormal: number
  readonly criticalRejected: number
  readonly processorFailures: number
  readonly exporterFailures: number
  readonly flushTimeouts: number
  readonly lastExportAt?: string
  readonly lastFailure?: SafeErrorRecord
}

export interface ObservationProcessor {
  readonly id: string
  transform(event: ObservationEvent): ObservationEvent | undefined
}

export interface ContentRedactor {
  readonly id: string
  redact(value: string, path: readonly string[]): string
}

export interface SdkLogger {
  child(fields: Readonly<JsonObject>): SdkLogger
  trace(message: string, fields?: Readonly<JsonObject>): void
  debug(message: string, fields?: Readonly<JsonObject>): void
  info(message: string, fields?: Readonly<JsonObject>): void
  warn(message: string, fields?: Readonly<JsonObject>): void
  error(message: string, fields?: Readonly<JsonObject>): void
  fatal(message: string, fields?: Readonly<JsonObject>): void
}

export interface LoggerContext {
  readonly invocation?: Pick<ModelInvocationContext, 'correlation' | 'resource' | 'scope'>
  readonly correlation?: CorrelationContext
  readonly resource?: ObservationResource
  readonly fields?: Readonly<JsonObject>
}

export interface ObservabilityOptions {
  readonly mode?: ObservationPort['mode']
  readonly resource?: Partial<Omit<ObservationResource, 'sdkName'>>
  readonly exporters?: readonly ObservationExporterRegistration[]
  readonly processors?: readonly ObservationProcessor[]
  readonly content?: ObservationContentPolicy
  readonly redactors?: readonly ContentRedactor[]
  readonly includeErrorStacks?: boolean
  readonly minimumLogLevel?: LogLevel
  readonly maxQueueEvents?: number
  readonly maxQueueBytes?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
  readonly flushTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly onHealthChange?: (health: ObservationHealthSnapshot) => void
  /** Optional synchronous tracing backend; invalid spans fall back to core IDs. */
  readonly openSpan?: ObservationPort['openSpan']
}

export interface Observability extends ObservationPort {
  readonly resource: ObservationResource
  checkpoint(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt>
  logger(context?: LoggerContext): SdkLogger
  health(): ObservationHealthSnapshot
  flush(signal?: AbortSignal): Promise<FlushResult>
  shutdown(signal?: AbortSignal): Promise<FlushResult>
}

export interface TraceProjection {
  readonly eventId: string
  readonly name: string
  readonly phase: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly status?: string
  readonly durationMs?: number
}

export interface LogProjection {
  readonly eventId: string
  readonly level: LogLevel
  readonly message: string
  readonly fields: JsonObject
  readonly traceId: string
  readonly spanId: string
}

export interface MetricProjection {
  readonly name: string
  readonly value: number
  readonly attributes: JsonObject
}
