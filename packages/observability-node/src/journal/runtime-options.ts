import { randomBytes } from 'node:crypto'
import type { ObservationBoundary } from '@ai-agent-sdk/core'
import type { JsonlObservationJournalOptions } from './types.ts'
import { JOURNAL_DEFAULTS, positiveSafeInteger } from './config.ts'

export interface RuntimeJournalOptions {
  readonly id: string
  readonly rootDir: string
  readonly mode: JsonlObservationJournalOptions['mode']
  readonly maxSegmentBytes: number
  readonly maxRetainedBytes: number
  readonly acknowledgedRetentionMs: number
  readonly syncIntervalMs: number
  readonly syncRecordCount: number
  readonly now: () => Date
  readonly segmentId: () => string
  readonly supportedBoundaries: readonly ObservationBoundary[]
}

export function captureRuntimeJournalOptions(options: JsonlObservationJournalOptions): RuntimeJournalOptions {
  if (typeof options !== 'object' || options === null) throw new TypeError('journal options are required')
  if (!['operational', 'reliable', 'audit'].includes(options.mode)) throw new TypeError('journal mode is invalid')
  const id = options.id ?? 'journal'
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(id)) throw new TypeError('journal id is invalid')
  if (typeof options.rootDir !== 'string' || options.rootDir.trim().length === 0) {
    throw new TypeError('observation journal rootDir must be explicit and non-empty')
  }
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('journal now must be a function')
  if (options.segmentId !== undefined && typeof options.segmentId !== 'function') {
    throw new TypeError('journal segmentId must be a function')
  }
  const supportedBoundaries: readonly ObservationBoundary[] = Object.freeze(
    options.mode === 'operational' ? ['none'] : ['local-durable'],
  )
  return Object.freeze({
    id,
    rootDir: options.rootDir,
    mode: options.mode,
    maxSegmentBytes: positiveSafeInteger(options.maxSegmentBytes ?? JOURNAL_DEFAULTS.maxSegmentBytes, 'maxSegmentBytes'),
    maxRetainedBytes: positiveSafeInteger(options.maxRetainedBytes ?? JOURNAL_DEFAULTS.maxRetainedBytes, 'maxRetainedBytes'),
    acknowledgedRetentionMs: positiveSafeInteger(
      options.acknowledgedRetentionMs ?? JOURNAL_DEFAULTS.acknowledgedRetentionMs, 'acknowledgedRetentionMs',
    ),
    syncIntervalMs: positiveSafeInteger(options.syncIntervalMs ?? JOURNAL_DEFAULTS.syncIntervalMs, 'syncIntervalMs'),
    syncRecordCount: positiveSafeInteger(options.syncRecordCount ?? JOURNAL_DEFAULTS.syncRecordCount, 'syncRecordCount'),
    now: options.now ?? (() => new Date()),
    segmentId: options.segmentId ?? (() => randomBytes(12).toString('hex')),
    supportedBoundaries,
  })
}
