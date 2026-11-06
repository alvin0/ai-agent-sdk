import type { DrainStepOutcome } from '../primitives/background-drain.ts'
import type { ObservationEvent, SafeErrorRecord } from '../observation/index.ts'
import type { FlushResult, ObservabilityOptions } from './types.ts'

export interface QueueEntry {
  readonly event: ObservationEvent
  readonly bytes: number
  readonly pending: Set<string>
  readonly protected: boolean
}

export interface MutableHealth {
  accepted: number
  exported: number
  droppedVerbose: number
  droppedNormal: number
  criticalRejected: number
  processorFailures: number
  exporterFailures: number
  flushTimeouts: number
  lastExportAt?: string
  lastFailure?: SafeErrorRecord
  requiredFailure: boolean
}

export interface FlushOutcome extends FlushResult {
  readonly requiredComplete: boolean
  /** How a background step went, for its pacing; never part of a public result. */
  readonly step: DrainStepOutcome
}

export type BusOptions = Required<Pick<ObservabilityOptions,
  'content' | 'includeErrorStacks' | 'minimumLogLevel' | 'maxQueueEvents' | 'maxQueueBytes'
  | 'maxBatchEvents' | 'maxBatchBytes' | 'flushTimeoutMs' | 'shutdownTimeoutMs'>>
  & Pick<ObservabilityOptions, 'redactors' | 'onHealthChange' | 'openSpan'>
