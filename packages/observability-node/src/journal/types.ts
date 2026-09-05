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
