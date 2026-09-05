import type {
  ExportAck,
  JsonValue,
  Observability,
  ObservationBatch,
  ObservationBoundary,
  ObservationContentPolicy,
  ObservationEvent,
  ObservationExporter,
  ObservationExporterPlugin,
} from '@ai-agent-sdk/core/observability'

export type JournalDurabilityMode = 'operational' | 'reliable' | 'audit'

export interface JsonlObservationJournalOptions {
  readonly id?: string
  readonly rootDir: string
  readonly mode: JournalDurabilityMode
  readonly maxSegmentBytes?: number
  readonly maxRetainedBytes?: number
  readonly acknowledgedRetentionMs?: number
  readonly syncIntervalMs?: number
  readonly syncRecordCount?: number
  readonly now?: () => Date
  readonly segmentId?: () => string
}

export interface JournalRecoveryRecord {
  readonly segment: string
  readonly line: number
  readonly event: ObservationEvent
  readonly payloadJson: string
}

export interface JournalRecoveryResult {
  readonly records: readonly JournalRecoveryRecord[]
  readonly quarantinedSegments: readonly string[]
  readonly truncatedSegments: readonly string[]
}

export interface JournalStats {
  readonly segmentCount: number
  readonly retainedBytes: number
  readonly unacknowledgedEvents: number
  readonly currentSegment?: string
}

/** Existing marker-free journal remains available for recovery and direct control. */
export declare class JsonlObservationJournalExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  constructor(options: JsonlObservationJournalOptions)
  ready(): Promise<void>
  stage(event: ObservationEvent): Promise<void>
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  acknowledgeBatch(batchId: string): Promise<number>
  acknowledgeEvents(eventIds: readonly string[]): Promise<void>
  recover(): Promise<JournalRecoveryResult>
  cleanup(): Promise<void>
  stats(): Promise<JournalStats>
  shutdown(signal: AbortSignal): Promise<void>
}

export declare function recoverJournal(rootInput: string): Promise<JournalRecoveryResult>

export interface NodeLifecycleTarget {
  on(event: 'beforeExit' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'beforeExit' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface NodeLifecycleOptions {
  readonly target?: NodeLifecycleTarget
  readonly signals?: readonly ('SIGINT' | 'SIGTERM')[]
  readonly onFailure?: (error: unknown) => void
}

export declare function installNodeObservabilityLifecycle(
  observation: Pick<Observability, 'shutdown'>,
  options?: NodeLifecycleOptions,
): () => void

export declare const NODE_OBSERVATION_ERROR_CODES: Readonly<{
  readonly corrupt: 'OBSERVABILITY_JOURNAL_CORRUPT'
  readonly io: 'OBSERVABILITY_JOURNAL_IO'
}>

export type NodeObservationErrorCode =
  typeof NODE_OBSERVATION_ERROR_CODES[keyof typeof NODE_OBSERVATION_ERROR_CODES]

export declare class NodeObservationError extends Error {
  readonly name: 'NodeObservationError'
  readonly code: NodeObservationErrorCode
  constructor(
    code: NodeObservationErrorCode,
    message: string,
    options?: ErrorOptions,
  )
}

export interface ProviderWireLogRecord {
  readonly schemaVersion: 1
  readonly type: string
  readonly provider: string
  readonly timestamp: string
  readonly [key: string]: JsonValue
}

export interface ProviderWireLogger {
  (record: ProviderWireLogRecord): Promise<void>
  shutdown(): Promise<void>
}

export interface DiagnosticWireLoggerOptions {
  readonly rootDir: string
  readonly content: ObservationContentPolicy
  readonly allowWireBodies: boolean
  readonly now?: () => Date
}

export declare function createDiagnosticWireLogger(
  options: DiagnosticWireLoggerOptions,
): ProviderWireLogger

export interface ProviderRequestLogLike {
  readonly provider: string
  readonly timestamp: string
}

export interface DailyJsonlRequestLoggerOptions {
  readonly rootDir?: string
  readonly content: 'full'
  readonly allowWireBodies: true
  readonly now?: () => Date
  readonly calendar?: 'local' | 'utc'
}

export type DailyJsonlRequestLogger = (
  (record: ProviderRequestLogLike) => Promise<void>
) & Pick<ProviderWireLogger, 'shutdown'>

export declare function createDailyJsonlRequestLogger(
  options: DailyJsonlRequestLoggerOptions,
): DailyJsonlRequestLogger

export declare function combineProviderRequestLoggers<
  RecordType extends ProviderRequestLogLike,
>(
  ...loggers: readonly ((record: RecordType) => Promise<void> | void)[]
): (record: RecordType) => Promise<void>

/** Recommended runtime adapter; it does not repurpose the advanced journal class. */
export declare function jsonlObservationExporter(
  options: JsonlObservationJournalOptions,
): ObservationExporterPlugin

export interface RuntimeJournalRecoveryRecord {
  readonly segment: string
  readonly line: number
  readonly kind: 'event' | 'run-terminal-record'
  readonly id: string
  readonly key: string
  readonly item: ObservationEvent | import('@ai-agent-sdk/core/observability').RunTerminalRecord
  readonly payloadJson: string
}

export interface RuntimeJournalRecoveryResult {
  readonly records: readonly RuntimeJournalRecoveryRecord[]
  readonly truncatedSegments: readonly string[]
  readonly quarantinedSegments: readonly string[]
}

export declare function recoverRuntimeObservationJournal(
  rootDir: string,
): Promise<RuntimeJournalRecoveryResult>
