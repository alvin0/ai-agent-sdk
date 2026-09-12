/**
 * Property test for embedding output-order restoration.
 *
 * Feature: embedding-support, Property 7: Thứ tự kết quả theo chỉ số input, độc
 * lập thứ tự hoàn thành.
 *
 * **Validates: Requirements 4.6, 8.4**
 *
 * The claim is about a mapping, not about a length: `embedMany()` must return at
 * position `i` the vector of the input at position `i`, no matter what happened
 * between. So the test never compares the output against another ordering the
 * SDK produced — it compares each returned vector against the vector the FAKE
 * PROVIDER produced for that exact text, recomputed independently from
 * `deterministicVector()`. A returned array that is internally consistent but
 * rotated by one fails, which is the whole point.
 *
 * Four independent sources of disorder run at once, because each one alone
 * leaves a plausible wrong implementation passing:
 *
 * 1. **Batch settlement order.** Each batch waits a scripted number of
 *    microtask/macrotask turns, so batches settle in an order unrelated to plan
 *    order. An implementation that appended vectors as batches resolved would
 *    pass with a single batch and fail here.
 * 2. **Permuted provider responses.** The adapter returns the vectors of one
 *    batch reversed, rotated, or shuffled, carrying `index` along. An
 *    implementation that zipped a batch's vectors positionally against the
 *    batch's items would pass with `order: 'input'` and fail here.
 * 3. **Retries.** Some batches fail their first attempts, so the surviving
 *    batches settle even further out of plan order and a retried batch lands
 *    last regardless of where its items sit in the input.
 * 4. **Cache hit/miss mixes.** A warm subset is served from the cache and never
 *    enters a batch at all, so the pending set is a sparse subsequence of the
 *    input and `item.index` is the ONLY thing that still relates the two. An
 *    implementation that wrote results at a position within the pending list
 *    would pass with a cold cache and fail here.
 *
 * Non-vacuity is asserted rather than assumed: the run loop records that it
 * really did observe out-of-plan settlement, a permuted response, a retry, a
 * cache hit and a multi-batch plan, and each generated case checks that the
 * expected vectors are pairwise distinct — with duplicate vectors a permutation
 * would be unobservable and every assertion below would be free.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/order.spec.ts`. No runner
 * collects that directory: root `vitest.config.ts` includes `tests/**`, and the
 * package configs reach into the ROOT `tests/` tree by relative path. It sits
 * beside `tests/unit/embedding/{planner,retry,usage}.spec.ts`, which document the
 * same deviation.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention in
 * the sibling embedding specs is a seeded mulberry32 generator: a failure
 * reproduces from the printed seed and nothing test-only enters the dependency
 * graph. `RUNS` is above the spec floor of 100.
 *
 * @module tests/unit/embedding/order.spec
 */

import { describe, expect, it } from 'vitest'
import {
  createEmbeddingModelHandle,
  type EmbeddingHandleOptions,
  type EmbeddingOperationScheduler,
} from '../../../packages/core/src/composition/embedding/handle.ts'
import { resolveRetryPolicy } from '../../../packages/core/src/contract/retry-policy.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheStore,
} from '../../../packages/core/src/embedding/handle.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult, EmbeddingVector } from '../../../packages/core/src/embedding/result.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import type { OperationLease, OperationOptions } from '../../../packages/core/src/composition/lifecycle/types.ts'
import {
  deterministicVector,
  FakeEmbeddingAdapter,
  type FakeEmbeddingBehaviour,
  type FakeVectorOrder,
  itemText,
} from '../../fixtures/embedding/fake-adapter.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, reproducible from a 32-bit seed. */
function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Rng = () => number

function intBelow(rng: Rng, bound: number): number {
  return Math.floor(rng() * bound)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

/** Fisher-Yates against the seeded source, so a shuffle reproduces too. */
function shuffled<T>(rng: Rng, values: readonly T[]): readonly T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = intBelow(rng, index + 1)
    ;[copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T]
  }
  return copy
}

// ---------------------------------------------------------------------------
// Runtime admission double
// ---------------------------------------------------------------------------

/**
 * The narrowest thing the handle will accept: one lease whose signal fuses the
 * caller's.
 *
 * Standing up a whole `RuntimeOperations` would drag close semantics into a test
 * about ordering; the handle's dependency is structural precisely so this can be
 * a dozen lines.
 */
function schedulerOf(): EmbeddingOperationScheduler {
  return {
    async execute<T>(
      _kind: 'embedding-call',
      options: OperationOptions,
      work: (lease: OperationLease) => Promise<T>,
    ): Promise<T> {
      const controller = new AbortController()
      const abort = (): void => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
      const lease: OperationLease = {
        signal: controller.signal,
        whenSealed: new Promise<void>(() => undefined),
        publish: (commit: () => void) => {
          commit()
          return true
        },
        settle: () => undefined,
      }
      try {
        return await work(lease)
      } finally {
        options.signal?.removeEventListener('abort', abort)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// A provider that settles out of order and fails a few times
// ---------------------------------------------------------------------------

/** How one batch of a generated case behaves. */
interface BatchScript {
  /** Turns to yield before responding; a crude but sufficient reordering knob. */
  readonly turns: number
  /**
   * Real delay before responding, for the one scenario that needs settlement
   * order pinned exactly rather than merely stirred.
   */
  readonly delayMs?: number
  /** Failed attempts before the batch succeeds. */
  readonly failures: number
  /** Response order for this batch's vectors. */
  readonly order: FakeVectorOrder
}

/**
 * A {@link FakeEmbeddingAdapter} whose per-batch delay, response order and
 * failure count are scripted by the batch's FIRST item index.
 *
 * Keyed by first item index rather than by dispatch ordinal on purpose: the
 * script must be a property of the batch, so that a retry of one batch reuses
 * that batch's script while its siblings keep theirs. Real timers are avoided;
 * yielding turns reorders settlement deterministically and costs no wall clock.
 */
class ScriptedOrderAdapter extends FakeEmbeddingAdapter {
  /** Batch keys in the order their responses were produced. */
  readonly settleOrder: number[] = []
  /** Batch keys in the order they were dispatched. */
  readonly dispatchOrder: number[] = []

  private readonly scripts: ReadonlyMap<number, BatchScript>
  private readonly fallback: BatchScript
  private readonly attemptsPerBatch = new Map<number, number>()

  constructor(
    behaviour: FakeEmbeddingBehaviour,
    scripts: ReadonlyMap<number, BatchScript>,
    fallback: BatchScript,
  ) {
    super(behaviour)
    this.scripts = scripts
    this.fallback = fallback
  }

  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const key = batch.items[0]?.index ?? -1
    const script = this.scripts.get(key) ?? this.fallback
    const attempt = (this.attemptsPerBatch.get(key) ?? 0) + 1
    this.attemptsPerBatch.set(key, attempt)
    this.dispatchOrder.push(key)

    for (let turn = 0; turn < script.turns; turn += 1) await Promise.resolve()
    if (script.turns % 3 === 2) await new Promise(resolve => setTimeout(resolve, 0))
    if (script.delayMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, script.delayMs))
    }

    if (attempt <= script.failures) {
      // Retryable under the default policy, so the batch comes back later and
      // settles well after the siblings that never failed.
      throw new ModelError('scripted transient failure', MODEL_ERROR_CODES.SERVER)
    }

    const result = await super.embedBatch(batch, context)
    this.settleOrder.push(key)
    return { ...result, vectors: reorderVectors(result.vectors, script.order) }
  }
}

/** Applies a per-batch response order on top of whatever the fixture returned. */
function reorderVectors(
  vectors: readonly EmbeddingVector[],
  order: FakeVectorOrder,
): readonly EmbeddingVector[] {
  if (typeof order === 'function') return order(vectors)
  switch (order) {
    case 'input':
      return vectors
    case 'reversed':
      return [...vectors].reverse()
    case 'rotated':
      return vectors.length < 2 ? vectors : [...vectors.slice(1), ...vectors.slice(0, 1)]
  }
}

// ---------------------------------------------------------------------------
// Case generation
// ---------------------------------------------------------------------------

const PURPOSES: readonly EmbeddingPurpose[] = Object.freeze([
  'retrieval-query',
  'retrieval-document',
])

/** An in-process cache store, plus a counter of the reads that hit. */
function storeOf(): { store: EmbeddingCacheStore; hits: { count: number } } {
  const entries = new Map<string, EmbeddingCacheEntry>()
  const hits = { count: 0 }
  return {
    hits,
    store: {
      get: (key: string) => {
        const entry = entries.get(key)
        if (entry !== undefined) hits.count += 1
        return entry
      },
      set: (key: string, entry: EmbeddingCacheEntry) => {
        entries.set(key, entry)
      },
    },
  }
}

/** One generated `Logical_Call`. */
interface GeneratedCase {
  readonly values: readonly string[]
  readonly purpose: EmbeddingPurpose
  readonly dimensions: number
  readonly maxItems: number
  readonly concurrency: number
  /** Values embedded in a warm-up call first, so their second read is a hit. */
  readonly warm: readonly string[]
  readonly scripts: ReadonlyMap<number, BatchScript>
  readonly fallback: BatchScript
  readonly useCache: boolean
}

const ORDERS: readonly FakeVectorOrder[] = Object.freeze(['input', 'reversed', 'rotated'])

function generateCase(rng: Rng, seed: number): GeneratedCase {
  const itemCount = 1 + intBelow(rng, 11)
  // Distinct texts: two equal inputs would have equal vectors, and a permutation
  // between them would be unobservable.
  const values = Array.from(
    { length: itemCount },
    (_value, index) => `case-${seed}/item-${index}/${'x'.repeat(1 + intBelow(rng, 6))}`,
  )
  const maxItems = 1 + intBelow(rng, 4)
  const useCache = rng() < 0.5
  const warm = useCache
    ? shuffled(rng, values).slice(0, intBelow(rng, values.length))
    : []

  const scripts = new Map<number, BatchScript>()
  for (let index = 0; index < itemCount; index += 1) {
    scripts.set(index, {
      turns: intBelow(rng, 6),
      // Kept low: every failure costs a real backoff sleep of a millisecond or two.
      failures: rng() < 0.25 ? 1 + intBelow(rng, 2) : 0,
      order: rng() < 0.4 ? shuffleOrder(rng) : pick(rng, ORDERS),
    })
  }

  return {
    values,
    purpose: pick(rng, PURPOSES),
    dimensions: 2 + intBelow(rng, 4),
    maxItems,
    concurrency: 1 + intBelow(rng, 4),
    warm,
    scripts,
    fallback: { turns: 0, failures: 0, order: 'input' },
    useCache,
  }
}

/** A seeded shuffle as a response order, so permutations are not only cyclic. */
function shuffleOrder(rng: Rng): FakeVectorOrder {
  return (vectors: readonly EmbeddingVector[]) => shuffled(rng, vectors)
}

/** What the provider produces for one text, recomputed independently. */
function expectedVectorFor(value: string, dimensions: number): readonly number[] {
  return deterministicVector(value, dimensions)
}

interface RunObservations {
  readonly embeddings: readonly (readonly number[])[]
  readonly adapter: ScriptedOrderAdapter
  readonly cacheHits: number
  readonly inputsFromCache: number
  readonly inputsFromProvider: number
}

/**
 * Runs one generated case: an optional warm-up call to populate the cache, then
 * the call under test over ALL inputs.
 *
 * The warm-up uses a separate adapter so its attempts never pollute the
 * evidence, and the same store, so the second call sees genuine hits for exactly
 * the warmed subset.
 */
async function runCase(generated: GeneratedCase): Promise<RunObservations> {
  const { hits, store } = storeOf()
  const behaviour: FakeEmbeddingBehaviour = { dimensions: generated.dimensions }
  const options: EmbeddingHandleOptions = {
    provider: 'fake',
    model: 'embed-order',
    dimensions: generated.dimensions,
    concurrency: generated.concurrency,
    batchLimits: { maxItems: generated.maxItems },
    ...(generated.useCache ? { cache: { store, scope: 'tenant-a' } } : {}),
  }
  const retryPolicy = resolveRetryPolicy(
    { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } },
    'test.retryPolicy',
  )

  if (generated.warm.length > 0) {
    const warmAdapter = new ScriptedOrderAdapter(behaviour, new Map(), generated.fallback)
    await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter: warmAdapter,
      options,
      retryPolicy,
    }).embedMany({ values: generated.warm, purpose: generated.purpose })
  }
  const hitsBefore = hits.count

  const adapter = new ScriptedOrderAdapter(behaviour, generated.scripts, generated.fallback)
  const result = await createEmbeddingModelHandle({
    operations: schedulerOf(),
    adapter,
    options,
    retryPolicy,
  }).embedMany({ values: generated.values, purpose: generated.purpose })

  return {
    embeddings: result.embeddings,
    adapter,
    cacheHits: hits.count - hitsBefore,
    inputsFromCache: result.usage.inputsFromCache,
    inputsFromProvider: result.usage.inputsFromProvider,
  }
}

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 7: Thứ tự kết quả theo chỉ số input, độc lập thứ tự hoàn thành', () => {
  it(`holds for ${RUNS} generated settlement, permutation, retry and cache mixes`, async () => {
    let sawOutOfPlanSettlement = false
    let sawPermutedResponse = false
    let sawRetry = false
    let sawCacheHit = false
    let sawMultiBatch = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x07_0000 + run
      const rng = rngOf(seed)
      const generated = generateCase(rng, seed)
      const observed = await runCase(generated)
      const context = { seed }

      const expected = generated.values.map(value =>
        expectedVectorFor(value, generated.dimensions))

      // Guard: with two equal expected vectors a swap between them would be
      // invisible and every assertion below would hold vacuously.
      const distinct = new Set(expected.map(vector => vector.join(',')))
      expect({ ...context, distinct: distinct.size })
        .toEqual({ ...context, distinct: expected.length })

      // The property itself: position `i` of the output carries the vector of the
      // input at position `i`, element for element.
      expect({ ...context, count: observed.embeddings.length })
        .toEqual({ ...context, count: generated.values.length })
      for (const [index, vector] of observed.embeddings.entries()) {
        expect({ ...context, index, vector: [...vector] })
          .toEqual({ ...context, index, vector: [...(expected[index] as readonly number[])] })
      }

      // Every input is accounted for exactly once, from one source or the other:
      // an output of the right length could otherwise hide a dropped input that
      // was covered by a duplicate.
      expect({ ...context, total: observed.inputsFromCache + observed.inputsFromProvider })
        .toEqual({ ...context, total: generated.values.length })

      // Non-vacuity bookkeeping, asserted once after the loop.
      const settle = observed.adapter.settleOrder
      const planOrder = [...settle].sort((left, right) => left - right)
      if (settle.some((key, index) => key !== planOrder[index])) sawOutOfPlanSettlement = true
      if (new Set(observed.adapter.dispatchOrder).size > 1) sawMultiBatch = true
      if (observed.adapter.dispatchOrder.length > settle.length) sawRetry = true
      if (observed.cacheHits > 0) sawCacheHit = true
      if ([...generated.scripts.values()].some(script => script.order !== 'input')) {
        sawPermutedResponse = true
      }
    }

    // Each of these is a wrong implementation that the generator must actually
    // have exercised for the property above to mean anything.
    expect({
      sawOutOfPlanSettlement,
      sawPermutedResponse,
      sawRetry,
      sawCacheHit,
      sawMultiBatch,
    }).toEqual({
      sawOutOfPlanSettlement: true,
      sawPermutedResponse: true,
      sawRetry: true,
      sawCacheHit: true,
      sawMultiBatch: true,
    })
  })

  it('restores order when a single batch is returned fully reversed', async () => {
    const values = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const adapter = new FakeEmbeddingAdapter({ dimensions: 3, order: 'reversed' })
    const result = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-order', dimensions: 3 },
    }).embedMany({ values, purpose: 'retrieval-document' })

    // One batch, so the provider's reversal is the only reordering in play.
    expect(adapter.attempts).toHaveLength(1)
    expect(result.embeddings.map(vector => [...vector]))
      .toEqual(values.map(value => [...expectedVectorFor(value, 3)]))
  })

  it('restores order when batches settle in exactly reverse plan order', async () => {
    const values = Array.from({ length: 6 }, (_value, index) => `doc-${index}`)
    const scripts = new Map<number, BatchScript>(
      // One item per batch, so batch key === item index; later items yield fewer
      // turns and therefore settle first.
      values.map((_value, index) => [index, {
        turns: 0,
        // Later items respond first, so settlement is the exact reverse of plan
        // order. All batches are in flight before the first timer fires.
        delayMs: (values.length - index) * 5,
        failures: 0,
        order: 'input' as const,
      }]),
    )
    const adapter = new ScriptedOrderAdapter(
      { dimensions: 4 },
      scripts,
      { turns: 0, failures: 0, order: 'input' },
    )
    const result = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: {
        provider: 'fake',
        model: 'embed-order',
        batchLimits: { maxItems: 1 },
        concurrency: values.length,
      },
    }).embedMany({ values, purpose: 'retrieval-query' })

    expect(adapter.settleOrder).toEqual([...adapter.settleOrder].sort((a, b) => b - a))
    expect(result.embeddings.map(vector => [...vector]))
      .toEqual(values.map(value => [...expectedVectorFor(value, 4)]))
  })

  it('restores order for a call served entirely from the cache', async () => {
    const values = ['one', 'two', 'three', 'four']
    const { store } = storeOf()
    const options: EmbeddingHandleOptions = {
      provider: 'fake',
      model: 'embed-order',
      dimensions: 5,
      cache: { store, scope: 'tenant-a' },
    }
    // Warm in reverse, so a cache that leaked write order into read order would
    // be caught by the second call's ordering.
    const warm = new FakeEmbeddingAdapter({ dimensions: 5 })
    await createEmbeddingModelHandle({ operations: schedulerOf(), adapter: warm, options })
      .embedMany({ values: [...values].reverse(), purpose: 'retrieval-document' })

    const adapter = new FakeEmbeddingAdapter({ dimensions: 5 })
    const result = await createEmbeddingModelHandle({ operations: schedulerOf(), adapter, options })
      .embedMany({ values, purpose: 'retrieval-document' })

    // Fully cached: zero `Provider_Attempt`, and still in input order.
    expect(adapter.attempts).toHaveLength(0)
    expect(result.usage.inputsFromCache).toBe(values.length)
    expect(result.embeddings.map(vector => [...vector]))
      .toEqual(values.map(value => [...expectedVectorFor(value, 5)]))
  })

  it('maps the one vector of embed() to the one input, whatever the response order', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: 3, order: 'rotated' })
    const result = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-order', dimensions: 3 },
    }).embed({ value: 'solo', purpose: 'retrieval-query' })

    expect([...result.embedding]).toEqual([...expectedVectorFor('solo', 3)])
    expect(itemText(adapter.attempts[0]!.batch.items[0]!)).toBe('solo')
  })
})
