import type { SpanId } from './context.ts'
import type { OperationStatus, SafeErrorRecord } from './event.ts'

export type UsageCoverage = 'complete' | 'partial' | 'estimated' | 'missing' | 'not-applicable'
export type DispatchState = 'not-sent' | 'sent' | 'unknown'

export interface UsageCounters {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface AttemptUsageReport {
  readonly attemptId: string
  readonly spanId: SpanId
  readonly attemptNumber: number
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly dispatchState: DispatchState
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  /** Scheme, host and explicit non-default port retained without path/query. */
  readonly origin?: string
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly error?: SafeErrorRecord
}

const COUNTER_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
type CounterKey = typeof COUNTER_KEYS[number]

export interface UsageValidationResult {
  readonly reported: UsageCounters
  readonly invalidFields: readonly CounterKey[]
  readonly complete: boolean
  readonly overflow: boolean
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readCounter(source: Readonly<Record<string, unknown>>, key: CounterKey): { value?: unknown; unreadable: boolean } {
  try {
    return { value: Reflect.get(source, key), unreadable: false }
  } catch {
    return { unreadable: true }
  }
}

/** Rejects invalid fields individually and derives a total only from valid disjoint buckets. */
export function validateUsageCounters(value: unknown, normalizedProviderReport = false): UsageValidationResult {
  const source = typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {}
  const counters: Partial<Record<CounterKey, number>> = {}
  const invalid: CounterKey[] = []
  for (const key of COUNTER_KEYS) {
    const read = readCounter(source, key)
    if (read.unreadable) {
      invalid.push(key)
      continue
    }
    const field = read.value
    if (field === undefined) continue
    if (validCounter(field)) counters[key] = field
    else invalid.push(key)
  }
  let disjoint = 0
  let overflow = false
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
    const next = disjoint + (counters[key] ?? 0)
    if (!Number.isSafeInteger(next)) {
      overflow = true
      disjoint = Number.MAX_SAFE_INTEGER
    } else disjoint = next
  }
  if (!overflow && counters.totalTokens !== undefined && counters.totalTokens < disjoint) {
    delete counters.totalTokens
    invalid.push('totalTokens')
  }
  if (counters.reasoningTokens !== undefined && counters.outputTokens !== undefined
    && counters.reasoningTokens > counters.outputTokens) {
    delete counters.reasoningTokens
    invalid.push('reasoningTokens')
  }
  const completeBuckets = counters.inputTokens !== undefined && counters.outputTokens !== undefined
  if (normalizedProviderReport && completeBuckets && counters.totalTokens === undefined && !overflow && invalid.length === 0) {
    counters.totalTokens = disjoint
  }
  return Object.freeze({
    reported: Object.freeze({ ...counters }),
    invalidFields: Object.freeze([...new Set(invalid)]),
    complete: completeBuckets && invalid.length === 0 && !overflow,
    overflow,
  })
}

export interface UsageAdditionResult {
  readonly counters: UsageCounters
  readonly overflow: boolean
}

export function addUsageCounters(values: readonly UsageCounters[]): UsageAdditionResult {
  const output: Partial<Record<CounterKey, number>> = {}
  let overflow = false
  let comparableTotal = true
  for (const value of values) {
    const validated = validateUsageCounters(value)
    if (validated.invalidFields.length > 0) {
      throw new TypeError('usage counters must be validated before aggregation')
    }
    // Individually valid buckets remain known even when their disjoint total
    // exceeds safe integer precision. Keep them and report loss of authority.
    overflow ||= validated.overflow
    if (hasUsageCounters(validated.reported) && validated.reported.totalTokens === undefined) {
      comparableTotal = false
    }
    for (const key of COUNTER_KEYS) {
      const addend = validated.reported[key]
      if (addend === undefined) continue
      const sum = (output[key] ?? 0) + addend
      if (!Number.isSafeInteger(sum) || sum > Number.MAX_SAFE_INTEGER) {
        output[key] = Number.MAX_SAFE_INTEGER
        overflow = true
      } else output[key] = sum
    }
  }
  // A subset's total cannot describe buckets summed over a wider scope.
  // Leaf reports retain the original evidence; do not invent missing buckets.
  if (!comparableTotal) delete output.totalTokens
  const validated = validateUsageCounters(output)
  overflow ||= validated.overflow
  return Object.freeze({ counters: validated.reported, overflow })
}

export function hasUsageCounters(value: UsageCounters | undefined): boolean {
  return value !== undefined && COUNTER_KEYS.some(key => value[key] !== undefined)
}

export function classifyUsageCoverage(
  attempts: readonly Pick<AttemptUsageReport, 'dispatchState' | 'coverage' | 'reported'>[],
  estimated?: UsageCounters,
): UsageCoverage {
  if (attempts.length === 0 || attempts.every(attempt => attempt.dispatchState === 'not-sent')) return 'not-applicable'
  const dispatched = attempts.filter(attempt => attempt.dispatchState !== 'not-sent')
  if (dispatched.length > 0 && dispatched.every(attempt => attempt.coverage === 'complete')) return 'complete'
  if (dispatched.some(attempt => hasUsageCounters(attempt.reported))) return 'partial'
  if (hasUsageCounters(estimated)) return 'estimated'
  return 'missing'
}

export function possiblyBilledAttemptsWithoutUsage(
  attempts: readonly Pick<AttemptUsageReport, 'dispatchState' | 'reported'>[],
): number {
  return attempts.filter(attempt => attempt.dispatchState !== 'not-sent' && !hasUsageCounters(attempt.reported)).length
}
