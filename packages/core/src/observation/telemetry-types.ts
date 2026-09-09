import type { ObservationEvent, SafeErrorRecord } from './event.ts'

export type ObservationContentPolicy = 'none' | 'metadata' | 'redacted' | 'full'

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
