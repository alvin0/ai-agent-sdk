export const JOURNAL_DEFAULTS = Object.freeze({
  maxSegmentBytes: 64 * 1024 * 1024,
  maxRetainedBytes: 1024 * 1024 * 1024,
  acknowledgedRetentionMs: 7 * 24 * 60 * 60 * 1000,
  syncIntervalMs: 100,
  syncRecordCount: 256,
})

export const JOURNAL_LIMITS = Object.freeze({
  recoverySegmentBytes: 65 * 1024 * 1024,
  cursorBytes: 64 * 1024 * 1024,
  identifierCharacters: 64,
})

export const JOURNAL_FILES = Object.freeze({
  advancedCursor: 'cursor.json',
  runtimeDirectory: 'runtime-delivery',
  runtimeCursor: 'cursor.json',
})

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

export function safeSegmentId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '')
  if (normalized.length < 8 || normalized.length > JOURNAL_LIMITS.identifierCharacters) {
    throw new TypeError('journal segmentId must yield 8-64 safe characters')
  }
  return normalized
}
