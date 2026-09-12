/**
 * Bounded-concurrency driver for `Physical_Batch`es of one `Logical_Call`.
 *
 * The whole point of this file is a memory bound. `planEmbeddingBatches()` is a
 * lazy generator, so a batch payload only exists once it has been pulled out of
 * it. If a caller drained that generator into an array first, peak payload
 * memory would scale with the corpus and Requirement 17.4 would be lost. So the
 * runner here NEVER drains its source: it holds one shared iterator and pulls
 * exactly one more batch each time a worker slot frees up. At most
 * `concurrency` batches are materialised at any instant, which is what makes
 * peak payload memory `concurrency × maxBytes` (Requirements 4.5, 17.4).
 *
 * The runner is generic over the batch type on purpose. It only needs "an
 * ordered source of work" and knows nothing about batching, retry, or vectors —
 * retry and order restoration live in `retry.ts` and write results by
 * `item.index`, so this file has no opinion about either.
 *
 * @module ai-agent-sdk/core/composition/embedding/limiter
 */

import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'

/**
 * In-flight `Physical_Batch`es allowed when a handle declares no `concurrency`.
 *
 * Small on purpose: the default has to be safe for the smallest deployment that
 * will ever run it, and a caller who knows their rate limit can raise it.
 */
export const DEFAULT_EMBEDDING_CONCURRENCY = 4

/**
 * Decides the in-flight bound for one `Logical_Call`.
 *
 * `undefined` means "not configured" and takes {@link DEFAULT_EMBEDDING_CONCURRENCY}.
 * Anything else that is not a positive integer is a configuration mistake, not
 * a value to quietly repair: silently turning `concurrency: 0` into `4` would
 * hide a caller bug behind traffic the caller did not expect to send.
 */
export function resolveEmbeddingConcurrency(configured?: number): number {
  if (configured === undefined) return DEFAULT_EMBEDDING_CONCURRENCY
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new EmbeddingError(
      'embedding concurrency must be a positive integer',
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  return configured
}

/** How a batch is executed once the runner has granted it a slot. */
export type BatchRunner<Batch> = (batch: Batch, ordinal: number) => Promise<void> | void

/** Knobs for {@link runBatchesWithConcurrency}. */
export interface ConcurrencyLimitOptions {
  /** Upper bound on simultaneously in-flight batches; resolved per {@link resolveEmbeddingConcurrency}. */
  readonly concurrency?: number
  /**
   * Caller signal or runtime `close()`.
   *
   * Once aborted, no further batch is pulled or started. Batches already in
   * flight are left to settle — cancelling them is the transport's job, not the
   * scheduler's (Requirement 12.3).
   */
  readonly signal?: AbortSignal
}

/** What the runner observed, so the caller can decide what an abort means. */
export interface ConcurrencyLimitOutcome {
  /** Batches that were handed to the runner function. */
  readonly started: number
  /** `true` when the source still had work but the signal stopped the runner. */
  readonly aborted: boolean
}

/**
 * Drives `source` with at most `concurrency` batches in flight.
 *
 * Accepts a sync or async iterable so a lazy `Generator` composes directly.
 * Pulls are serialised — an async iterator may not have two `next()` calls
 * outstanding — while the work itself overlaps.
 *
 * Failure is fail-fast on the scheduling side only: the first rejection stops
 * new batches from starting, the runner still awaits the batches already in
 * flight, and then that first error is rethrown. Recording a batch as failed
 * versus retryable is `retry.ts`'s decision, so a `run` that resolves is simply
 * "this slot is free again".
 *
 * An abort is NOT thrown here. The runner reports it in
 * {@link ConcurrencyLimitOutcome.aborted} and lets the caller choose between
 * partial results and an `EMBEDDING_ABORTED` failure, because only the caller
 * knows whether any batch had already succeeded.
 */
export async function runBatchesWithConcurrency<Batch>(
  source: Iterable<Batch> | AsyncIterable<Batch>,
  run: BatchRunner<Batch>,
  options?: ConcurrencyLimitOptions,
): Promise<ConcurrencyLimitOutcome> {
  const limit = resolveEmbeddingConcurrency(options?.concurrency)
  const signal = options?.signal
  const isAborted = (): boolean => signal?.aborted === true
  const iterator = openIterator(source)

  let started = 0
  let aborted = false
  let exhausted = false
  let failure: { readonly error: unknown } | undefined
  /** Serialises `next()` so no two pulls overlap on an async iterator. */
  let pull: Promise<void> = Promise.resolve()

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined || exhausted) return
      if (isAborted()) {
        aborted = true
        return
      }

      // Claim the next batch under the pull lock: one item, one owner, and the
      // source is advanced exactly as far as there is capacity to run it.
      const claimed = pull.then(async (): Promise<Claim<Batch> | undefined> => {
        if (failure !== undefined || exhausted || isAborted()) return undefined
        const next = await iterator.next()
        // Cancellation or another worker's failure can happen during an async pull.
        if (isAborted()) {
          aborted = true
          return undefined
        }
        if (failure !== undefined) return undefined
        if (next.done === true) {
          exhausted = true
          return undefined
        }
        const claim: Claim<Batch> = { batch: next.value }
        return claim
      })
      pull = claimed.then(() => undefined, () => undefined)

      let work: Claim<Batch> | undefined
      try {
        work = await claimed
      } catch (error) {
        failure ??= { error }
        return
      }
      if (work === undefined) continue
      if (failure !== undefined) return
      if (isAborted()) {
        aborted = true
        return
      }

      try {
        await run(work.batch, started++)
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let slot = 0; slot < limit; slot += 1) workers.push(worker())
  await Promise.all(workers)

  if (failure !== undefined) {
    await closeIterator(iterator)
    throw failure.error
  }
  if (aborted || !exhausted) {
    await closeIterator(iterator)
    return { started, aborted: aborted || !exhausted }
  }
  return { started, aborted: false }
}

/** One batch a worker owns for the duration of its slot. */
interface Claim<Batch> {
  readonly batch: Batch
}

/** Normalises a sync or async iterable to one async-shaped iterator. */
function openIterator<Batch>(
  source: Iterable<Batch> | AsyncIterable<Batch>,
): AsyncIterator<Batch> | Iterator<Batch> {
  const asAsync = (source as AsyncIterable<Batch>)[Symbol.asyncIterator]
  if (typeof asAsync === 'function') return asAsync.call(source)
  const asSync = (source as Iterable<Batch>)[Symbol.iterator]
  if (typeof asSync === 'function') return asSync.call(source)
  throw new EmbeddingError(
    'embedding batch source must be iterable',
    EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
  )
}

/**
 * Lets an abandoned generator run its `finally` blocks.
 *
 * A lazy planner may hold a buffer for the batch it was building; leaving the
 * generator suspended forever keeps that alive, which is the same leak this
 * file exists to prevent.
 */
async function closeIterator<Batch>(
  iterator: AsyncIterator<Batch> | Iterator<Batch>,
): Promise<void> {
  try {
    await iterator.return?.(undefined)
  } catch {
    // A source that fails while closing has nothing left to tell us; the
    // scheduling outcome already reported is the honest answer.
  }
}
