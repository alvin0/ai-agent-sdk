/**
 * Usage accounting for embedding.
 *
 * Embedding has no output tokens, so it does NOT reuse `UsageCounters` /
 * `validateUsageCounters`: that shape only reports `complete` once
 * `outputTokens` is present, which for embedding could only be satisfied by
 * inventing a `0`. Usage honesty forbids that. Missing or malformed usage stays
 * missing here — it remains evidence of a `Provider_Attempt`, but never leaves
 * the runtime as a published number.
 *
 * @module ai-agent-sdk/core/embedding/usage
 */

/** Tokens a provider actually reported for embedding work. Never contains `outputTokens`. */
export interface EmbeddingTokenUsage {
  readonly inputTokens: number
  readonly totalTokens?: number
}

/**
 * Coverage of a `Logical_Call`'s usage.
 *
 * `complete` only when every batch sent to the provider returned readable usage.
 */
export type EmbeddingUsageStatus = 'complete' | 'partial' | 'missing'

/** What the runtime publishes about the usage of one `Logical_Call`. */
export interface EmbeddingUsageReport {
  readonly status: EmbeddingUsageStatus
  /** Present only when `status === 'complete'`. Never a `TokenUsage`. */
  readonly tokens?: EmbeddingTokenUsage
  readonly batches: number
  readonly batchesWithUsage: number
  readonly providerAttempts: number
  readonly inputsFromCache: number
  readonly inputsFromProvider: number
}

const COUNTER_KEYS = ['inputTokens', 'totalTokens'] as const
export type EmbeddingCounterKey = typeof COUNTER_KEYS[number]

/** Counterpart of `UsageValidationResult` for embedding. */
export interface EmbeddingUsageValidation {
  /**
   * Absent when the provider reported no readable `inputTokens`. No branch
   * substitutes a `0`: an unreported counter is unknown, not zero.
   */
  readonly reported?: EmbeddingTokenUsage
  readonly invalidFields: readonly EmbeddingCounterKey[]
  readonly complete: boolean
  readonly overflow: boolean
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readCounter(source: Readonly<Record<string, unknown>>, key: EmbeddingCounterKey): { value?: unknown; unreadable: boolean } {
  try {
    return { value: Reflect.get(source, key), unreadable: false }
  } catch {
    return { unreadable: true }
  }
}

/**
 * Rejects invalid fields individually and keeps only counters the provider
 * genuinely reported. A hostile or malformed payload yields
 * `reported === undefined` rather than a fabricated total.
 */
export function validateEmbeddingUsage(value: unknown): EmbeddingUsageValidation {
  const source = typeof value === 'object' && value !== null ? value as Readonly<Record<string, unknown>> : {}
  const counters: Partial<Record<EmbeddingCounterKey, number>> = {}
  const invalid: EmbeddingCounterKey[] = []
  let overflow = false
  for (const key of COUNTER_KEYS) {
    const read = readCounter(source, key)
    if (read.unreadable) {
      invalid.push(key)
      continue
    }
    const field = read.value
    if (field === undefined) continue
    if (validCounter(field)) counters[key] = field
    else {
      // A count past safe-integer precision is authority lost, not merely a bad field.
      if (typeof field === 'number' && field > Number.MAX_SAFE_INTEGER) overflow = true
      invalid.push(key)
    }
  }
  // A total below the only disjoint bucket cannot describe the same call.
  if (counters.inputTokens !== undefined && counters.totalTokens !== undefined
    && counters.totalTokens < counters.inputTokens) {
    delete counters.totalTokens
    invalid.push('totalTokens')
  }
  const inputTokens = counters.inputTokens
  // Without a reported input bucket there is nothing honest to publish.
  const reported = inputTokens === undefined
    ? undefined
    : Object.freeze<EmbeddingTokenUsage>(counters.totalTokens === undefined
      ? { inputTokens }
      : { inputTokens, totalTokens: counters.totalTokens })
  return Object.freeze({
    ...(reported === undefined ? {} : { reported }),
    invalidFields: Object.freeze([...new Set(invalid)]),
    complete: reported !== undefined && invalid.length === 0 && !overflow,
    overflow,
  })
}

/** True when the provider reported at least one readable embedding counter. */
export function hasEmbeddingUsage(value: EmbeddingTokenUsage | undefined): boolean {
  return value !== undefined && COUNTER_KEYS.some(key => value[key] !== undefined)
}

/**
 * Applies the status rule to batches that were actually sent to the provider.
 * Batches served from cache are not evidence of unreported usage.
 */
export function classifyEmbeddingUsageStatus(batchesSent: number, batchesWithUsage: number): EmbeddingUsageStatus {
  if (batchesWithUsage <= 0) return 'missing'
  return batchesWithUsage >= batchesSent ? 'complete' : 'partial'
}
