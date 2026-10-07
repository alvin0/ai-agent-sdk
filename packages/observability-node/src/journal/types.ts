import type { ObservationEvent } from '@alvin0/ai-agent-sdk-core'

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
