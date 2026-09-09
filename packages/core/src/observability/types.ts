import {
  type JsonObject,
} from '../primitives/index.ts'
import {
  type CaptureReceipt,
  type CorrelationContext,
  type ModelInvocationContext,
  type ObservationBoundary,
  type ObservationEvent,
  type ObservationPort,
  type ObservationResource,
} from '../observation/index.ts'
import type { LogLevel, SdkLogger } from '../logging/types.ts'
import type {
  ContentRedactor,
  ObservationContentPolicy,
  ObservationHealthSnapshot,
  ObservationProcessor,
} from '../observation/telemetry-types.ts'

export type { IntegrationOperationEvidenceFields, LogLevel, SdkLogger } from '../logging/types.ts'
export type {
  ContentRedactor,
  ObservationContentPolicy,
  ObservationHealthSnapshot,
  ObservationProcessor,
} from '../observation/telemetry-types.ts'

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
  /**
   * Start local staging synchronously after privacy processing and queue
   * acceptance. Any returned promise is completed by `export`; it is not a
   * durability claim and capture never awaits it.
   */
  stage?(event: ObservationEvent): void | Promise<void>
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
