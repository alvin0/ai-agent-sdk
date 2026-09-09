import type {
  ModelCallReport, ObservationDeliverySummary, ObservationEvent, ObservationResource,
  OperationStatus, TraceId,
} from '../../observation/index.ts'
import type { SupportSafeError } from '../../support-safe/error.ts'
import type { RunOperationCounts, RunUsageReport, TrackedOperationKind } from './report.ts'

export type { SupportSafeError } from '../../support-safe/error.ts'

export interface ToolSourceRunReference {
  readonly sourceId: string
  readonly revision: string
}

export interface RunTerminalRecord {
  readonly kind: 'run-terminal-record'
  readonly runId: string
  readonly traceId: TraceId
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly status: OperationStatus
  readonly usage: RunUsageReport
  readonly modelCalls: readonly ModelCallReport[]
  readonly toolSourceSnapshots: readonly ToolSourceRunReference[]
  readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>
  readonly errors: readonly SupportSafeError[]
}

export interface RunReport extends RunTerminalRecord {
  readonly delivery: ObservationDeliverySummary
}

export interface ObservationDeliveryBatch {
  readonly id: string
  readonly resource: ObservationResource
  readonly events: readonly ObservationEvent[]
  readonly runRecords: readonly RunTerminalRecord[]
}

export interface ObservationDeliveryAck {
  readonly batchId: string
  readonly acceptedEventIds: readonly string[]
  readonly acceptedRunIds: readonly string[]
}

export type ObservationExportItem = ObservationEvent | RunTerminalRecord
