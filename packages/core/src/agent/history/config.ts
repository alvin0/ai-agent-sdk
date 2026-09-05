import { type HistoryLimits, type ResolvedHistoryLimits } from './types.ts'

export const MAX_CONTENT_DEPTH = 64
export function resolveHistoryLimits(input: HistoryLimits): ResolvedHistoryLimits {
  const maxEntries = positiveLimit(input.maxEntries ?? 100_000, 'maxEntries')
  const maxEntryBytes = positiveLimit(input.maxEntryBytes ?? 16 * 1024 * 1024, 'maxEntryBytes')
  const maxBytes = positiveLimit(input.maxBytes ?? 128 * 1024 * 1024, 'maxBytes')
  if (maxEntryBytes > maxBytes) throw new RangeError('history maxEntryBytes must not exceed maxBytes')
  return Object.freeze({ maxEntries, maxEntryBytes, maxBytes })
}

export function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`history ${name} must be a positive safe integer`)
  return value
}

export function serializedBytes(value: unknown): number {
  let json: string | undefined
  try { json = JSON.stringify(value) }
  catch (error: unknown) { throw new TypeError('history value must be JSON-serializable', { cause: error }) }
  if (json === undefined) throw new TypeError('history value must be JSON-serializable')
  return new TextEncoder().encode(json).byteLength
}
