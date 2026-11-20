import type { ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import type { ExportAck } from '@alvin0/ai-agent-sdk-core/observability'
import type { FileHandle } from 'node:fs/promises'

export interface CursorFile {
  readonly schemaVersion: 1
  readonly acknowledgedEventIds: readonly string[]
}

export interface SegmentState {
  readonly name: string
  readonly day: string
  readonly handle: FileHandle
  bytes: number
}

export interface PendingStage {
  readonly payloadJson: string
  readonly promise: Promise<void>
}

export interface JournalStats {
  readonly segmentCount: number
  readonly retainedBytes: number
  readonly unacknowledgedEvents: number
  readonly currentSegment?: string
}

export interface CapturedJournalEvent {
  readonly eventId: string
  readonly priority: ObservationEvent['priority']
  readonly payloadJson: string
  readonly payloadHash: string
}

export interface JournalBatchReceipt {
  delivered: boolean
  readonly eventIds: readonly string[]
  readonly payloadHash: string
  readonly promise: Promise<ExportAck>
}

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
