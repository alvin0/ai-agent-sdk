import type { Context, Meter, Tracer } from '@opentelemetry/api'
import type {
  ObservationContentPolicy,
  ObservationPort,
  ObservationProcessor,
  SafeErrorRecord,
} from '@ai-agent-sdk/core/observability'

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

export interface OpenTelemetryBridgeOptions {
  readonly tracer: Tracer
  readonly meter: Meter
  readonly logger?: OpenTelemetryLogger
  readonly content?: ObservationContentPolicy
  readonly onDiagnostic?: (error: SafeErrorRecord) => void
}

export interface OpenTelemetryBridge {
  readonly openSpan: ObservationPort['openSpan']
  readonly processor: ObservationProcessor
  diagnostics(): readonly SafeErrorRecord[]
}

export declare const OTEL_SEMANTIC_CONVENTIONS_COMMIT:
  '5ca9052bc796ef1e497200b1d558fd87a201f335'

export declare class OpenTelemetryBridgeError extends Error {
  readonly name: 'OpenTelemetryBridgeError'
  readonly code: 'OTEL_PROVIDER_UNCONFIGURED'
}

/** Caller owns the supplied OTel providers; runtime captures only this bridge's callbacks. */
export declare function createOpenTelemetryBridge(
  options: OpenTelemetryBridgeOptions,
): OpenTelemetryBridge
