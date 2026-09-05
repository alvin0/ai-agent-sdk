import type { ObservationEvent, ObservationPriority } from '../../observation/index.ts'
import type { ObservationExportItem, RunTerminalRecord } from '../exporter/delivery-types.ts'

export interface DeliveryQueueEntry {
  readonly ordinal: number
  readonly kind: 'event' | 'run-record'
  readonly id: string
  readonly runId: string
  readonly sequence?: number
  readonly priority: ObservationPriority
  readonly bytes: number
  readonly item: ObservationExportItem
}

export interface QueueAdmission {
  readonly status: 'accepted' | 'existing' | 'rejected' | 'closed'
  readonly reason?: 'capacity' | 'batch-capacity' | 'closed' | 'processor-failed'
  readonly entry?: DeliveryQueueEntry
}

export interface DeliveryQueueSnapshot {
  readonly queuedItems: number
  readonly queuedBytes: number
  readonly evictedVerbose: number
  readonly evictedNormal: number
  readonly evictedBytes: number
  readonly criticalRejected: number
  readonly accepted: number
  readonly entries: readonly DeliveryQueueEntry[]
}

export type DeliveryQueueEvent = ObservationEvent
export type DeliveryQueueRecord = RunTerminalRecord
