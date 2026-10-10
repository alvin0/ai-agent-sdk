export interface SnapshotValidationState {
  readonly messageIds: Set<string>
  readonly toolCallIds: Set<string>
  readonly nativeToolIds: Set<string>
  readonly toolCallEventIds: Set<string>
  readonly compactions: Map<string, { summary: boolean; end: boolean }>
  readonly visibleMessageSeqs: Set<number>
}

export function validateUsage(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  for (const field of [
    'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  ] as const) {
    const tokenCount = value[field]
    if ((field === 'inputTokens' || field === 'outputTokens') || tokenCount !== undefined) {
      nonNegativeInteger(tokenCount, `${path}.${field}`)
    }
  }
}

export function validateSeqTargets(value: unknown, nextSeq: number, path: string): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
  if (value.some(seq => !Number.isInteger(seq) || seq < 1 || seq >= nextSeq)) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

export function positiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${path} must be a positive integer`)
}

export function nonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${path} must be a non-negative integer`)
}

export function validateIsoTimestamp(value: unknown, path: string): void {
  const timestamp = nonEmptyString(value, path)
  const date = new Date(timestamp)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new TypeError(`${path} must be an ISO timestamp`)
  }
}

