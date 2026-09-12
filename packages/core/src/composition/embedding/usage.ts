/**
 * Aggregates per-batch usage evidence into one honest `Logical_Call` report.
 *
 * The vocabulary (`EmbeddingTokenUsage`, `EmbeddingUsageReport`,
 * `EmbeddingUsageStatus`, `validateEmbeddingUsage`,
 * `classifyEmbeddingUsageStatus`) is owned by `embedding/usage.ts`. This file
 * adds only the aggregation: it walks the evidence collected from every
 * `Physical_Batch` that was actually dispatched and folds it into a single
 * report plus warnings.
 *
 * Two rules drive every branch here:
 *
 * 1. Nothing is invented. A batch whose provider reported no readable usage
 *    contributes no tokens, and its absence downgrades the whole call to
 *    `partial` or `missing` rather than being counted as a zero
 *    (Requirements 16.2, 16.3). The absence is also stated out loud: a batch that
 *    reported nothing raises `usage-unreported`, one whose report could not be
 *    read raises `usage-malformed`.
 * 2. Cache and provider input counts are derived from the same evidence, so
 *    `inputsFromCache + inputsFromProvider === inputCount` holds by
 *    construction rather than by a caller remembering to keep them in step
 *    (Requirement 5.4).
 *
 * @module ai-agent-sdk/core/composition/embedding/usage
 */

import type { EmbeddingWarning } from '../../embedding/result.ts'
import type { EmbeddingTokenUsage, EmbeddingUsageReport } from '../../embedding/usage.ts'
import { classifyEmbeddingUsageStatus, validateEmbeddingUsage } from '../../embedding/usage.ts'

/**
 * What one dispatched `Physical_Batch` left behind.
 *
 * `usage` is deliberately `unknown`: it is raw provider evidence that has not
 * been proven to be a usage shape yet. `validateEmbeddingUsage` is the only
 * thing allowed to decide what it means.
 */
export interface EmbeddingBatchUsageEvidence {
  /** Input indexes this batch carried, in `Logical_Call` numbering. */
  readonly itemIndexes: readonly number[]
  /** `Provider_Attempt`s spent on this batch, retries included (Requirement 16.6). */
  readonly attempts: number
  /** Absent when the provider reported nothing at all. */
  readonly usage?: unknown
}

/** Everything the aggregator needs about one `Logical_Call`. */
export interface EmbeddingUsageAggregationInput {
  /** Inputs of the `Logical_Call`, cache hits included. */
  readonly inputCount: number
  /** Evidence for the batches that were sent to the provider; cache hits have none. */
  readonly batches: readonly EmbeddingBatchUsageEvidence[]
}

/** The report and the warnings that explain it. */
export interface EmbeddingUsageAggregation {
  readonly report: EmbeddingUsageReport
  readonly warnings: readonly EmbeddingWarning[]
}

interface BatchReading {
  /** Present only when the provider reported a readable input bucket. */
  readonly reported?: EmbeddingTokenUsage
  readonly malformed: boolean
}

/**
 * Turns one batch's raw evidence into a readable-or-not decision.
 *
 * `overflow` is treated as unreadable, not as a large number: a count past safe
 * integer precision is authority lost, so it may not enter a published total.
 */
function readBatch(evidence: EmbeddingBatchUsageEvidence): BatchReading {
  if (evidence.usage === undefined) return { malformed: false }
  const validation = validateEmbeddingUsage(evidence.usage)
  const malformed = validation.invalidFields.length > 0 || validation.overflow
  const reported = validation.overflow ? undefined : validation.reported
  return reported === undefined ? { malformed: true } : { reported, malformed }
}

function malformedWarning(itemIndexes: readonly number[]): EmbeddingWarning {
  return Object.freeze<EmbeddingWarning>({
    code: 'usage-malformed',
    ...(itemIndexes.length === 0 ? {} : { itemIndexes: Object.freeze([...itemIndexes]) }),
    message: 'provider reported usage that could not be read as embedding token counts',
  })
}

/**
 * Raised for a batch that was dispatched and came back with no usage at all.
 *
 * This is the absence half of Requirement 16.2, and it belongs here rather than
 * in an adapter: `status: 'missing'`/`'partial'` and the warning that explains it
 * are the same statement about the same evidence, and only the aggregator knows
 * a batch was dispatched. An endpoint that reports nothing by design — Gemini's
 * `batchEmbedContents` — therefore needs no per-provider warning code, and no
 * provider can report a `0` in place of the silence and have it pass unremarked.
 */
function unreportedWarning(itemIndexes: readonly number[]): EmbeddingWarning {
  return Object.freeze<EmbeddingWarning>({
    code: 'usage-unreported',
    ...(itemIndexes.length === 0 ? {} : { itemIndexes: Object.freeze([...itemIndexes]) }),
    message: 'provider reported no usage for this batch; no token count was assumed',
  })
}

/**
 * Counts the distinct inputs the provider actually saw.
 *
 * Indexes outside the `Logical_Call` range are ignored rather than trusted:
 * counting them would let `inputsFromProvider` exceed `inputCount` and break the
 * sum invariant that Requirement 5.4 asks for.
 */
function countProviderInputs(batches: readonly EmbeddingBatchUsageEvidence[], inputCount: number): number {
  const seen = new Set<number>()
  for (const batch of batches) {
    for (const index of batch.itemIndexes) {
      if (Number.isInteger(index) && index >= 0 && index < inputCount) seen.add(index)
    }
  }
  return seen.size
}

/**
 * Folds batch evidence into one `EmbeddingUsageReport`.
 *
 * `status` follows the coverage of the batches that were dispatched, so a call
 * served entirely from cache reports `missing` with `batches: 0` instead of
 * claiming complete knowledge of a cost that was never incurred. `tokens` is
 * published only for `complete`, and `totalTokens` only when every readable
 * batch reported one — a partial sum of totals would understate the call.
 */
export function aggregateEmbeddingUsage(input: EmbeddingUsageAggregationInput): EmbeddingUsageAggregation {
  const inputCount = Number.isSafeInteger(input.inputCount) && input.inputCount > 0 ? input.inputCount : 0
  const batches = input.batches
  const warnings: EmbeddingWarning[] = []

  let batchesWithUsage = 0
  // The sum of every attempt spent on the call, retries included. Zero here can
  // only come from an empty batch list, never from a default (Requirement 16.6).
  let providerAttempts = 0
  let inputTokens = 0
  let totalTokens = 0
  let everyReadableBatchHasTotal = true

  for (const batch of batches) {
    providerAttempts += Number.isSafeInteger(batch.attempts) && batch.attempts > 0 ? batch.attempts : 0
    const reading = readBatch(batch)
    // Absence and unreadability are different facts about the provider, so they
    // carry different codes; neither one contributes a token count.
    if (batch.usage === undefined) warnings.push(unreportedWarning(batch.itemIndexes))
    else if (reading.malformed) warnings.push(malformedWarning(batch.itemIndexes))
    if (reading.reported === undefined) continue
    batchesWithUsage += 1
    inputTokens += reading.reported.inputTokens
    if (reading.reported.totalTokens === undefined) everyReadableBatchHasTotal = false
    else totalTokens += reading.reported.totalTokens
  }

  const status = classifyEmbeddingUsageStatus(batches.length, batchesWithUsage)
  const inputsFromProvider = countProviderInputs(batches, inputCount)
  const tokens = status === 'complete'
    ? Object.freeze<EmbeddingTokenUsage>(everyReadableBatchHasTotal
      ? { inputTokens, totalTokens }
      : { inputTokens })
    : undefined

  return Object.freeze({
    report: Object.freeze<EmbeddingUsageReport>({
      status,
      ...(tokens === undefined ? {} : { tokens }),
      batches: batches.length,
      batchesWithUsage,
      providerAttempts,
      // Derived from the same evidence, so the two always sum to `inputCount`.
      inputsFromCache: inputCount - inputsFromProvider,
      inputsFromProvider,
    }),
    warnings: Object.freeze(warnings),
  })
}
