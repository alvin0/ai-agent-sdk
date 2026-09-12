/**
 * Property tests for the lazy batch planner and the bounded-concurrency runner.
 *
 * Feature: embedding-support, Property 5: Batch tôn trọng ba giới hạn và bộ nhớ
 * bị chặn trên.
 *
 * Feature: embedding-support, Property 6: Số batch chạy đồng thời không vượt cấu
 * hình.
 *
 * **Validates: Requirements 4.4, 4.5, 17.4**
 *
 * Both properties have a half that is easy to assert vacuously, so each one is
 * instrumented rather than merely observed:
 *
 * - The "bộ nhớ bị chặn trên" half of Property 5 is not a statement about the
 *   batches that come out, it is a statement about how far the SOURCE was read.
 *   A planner that drained its input into an array first would still satisfy
 *   every limit check. So the corpus is handed in as a counting generator and
 *   the planner is stepped one batch at a time: at the instant batch `k` is
 *   yielded, at most one item beyond the items already emitted may have been
 *   pulled (the item whose arrival closed the batch). That bounds retained
 *   items by `maxItems + 1`, independent of corpus size (Requirement 17.4).
 *
 * - Property 6 measures the peak of batches simultaneously in flight AND the
 *   peak of batches simultaneously materialised out of the source. Each `run`
 *   awaits a real macrotask, so overlap is genuine rather than an artifact of a
 *   synchronous callback that never yields. Non-vacuity is asserted globally:
 *   at least one generated case must actually saturate its slots, otherwise a
 *   runner that executed everything serially would pass a bound check for free.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/planner.spec.ts`. No
 * runner collects that directory — the root `vitest.config.ts` includes
 * `tests/**`, and the package configs reach into the ROOT `tests/` tree by
 * relative path. A spec there would silently never run in CI. It sits beside
 * `tests/unit/embedding/{profile,validation,surface}.spec.ts` instead, which is
 * the same deviation those files document.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The established
 * convention (`tests/unit/embedding/validation.spec.ts`) is a seeded mulberry32
 * generator: a failure reproduces from the printed seed and nothing enters the
 * dependency graph for test-only reasons. Each property runs `RUNS` cases,
 * above the spec floor of 100.
 */

import { describe, expect, it } from 'vitest'
import {
  planEmbeddingBatches,
  type EmbeddingBatchPlan,
} from '../../../packages/core/src/composition/embedding/planner.ts'
import {
  DEFAULT_EMBEDDING_CONCURRENCY,
  resolveEmbeddingConcurrency,
  runBatchesWithConcurrency,
} from '../../../packages/core/src/composition/embedding/limiter.ts'
import {
  estimateTokens,
  type ResolvedEmbeddingBatchLimits,
} from '../../../packages/core/src/embedding/limits.ts'
import type { EmbeddingItem } from '../../../packages/core/src/embedding/request.ts'

it('does not dispatch an async batch that arrives after abort', async () => {
  const controller = new AbortController()
  let started = 0
  let closed = false
  async function* source() {
    try {
      controller.abort()
      yield 1
    } finally { closed = true }
  }
  const result = await runBatchesWithConcurrency(source(), () => { started++ }, {
    signal: controller.signal, concurrency: 1,
  })
  expect(started).toBe(0)
  expect(result).toEqual({ started: 0, aborted: true })
  expect(closed).toBe(true)
})

it('measures the concatenated wire text across part boundaries', () => {
  const items: EmbeddingItem[] = [{ index: 0, contentParts: [...'abcd'].map(text => ({ type: 'text', text })) }]
  const limits = { maxItems: 10, maxTokens: 100, maxBytes: 100, estimateTokens }
  expect([...planEmbeddingBatches(items, limits)][0]?.estimatedTokens).toBe(estimateTokens('abcd'))
  const unicode: EmbeddingItem[] = [{ index: 0, contentParts: [
    { type: 'text', text: '\ud83d' }, { type: 'text', text: '\ude00' },
  ] }]
  expect([...planEmbeddingBatches(unicode, limits)][0]?.bytes).toBe(4)
})

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
const RUNS = 120

/** mulberry32 — small, fast, and reproducible from a 32-bit seed. */
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

function intBetween(rng: Rng, min: number, maxInclusive: number): number {
  return min + intBelow(rng, maxInclusive - min + 1)
}

const ENCODER = new TextEncoder()

/** UTF-8 size of an item, measured independently of the planner. */
function bytesOf(item: EmbeddingItem): number {
  return ENCODER.encode(item.contentParts.map(part => part.text).join('')).byteLength
}

/** Token size of an item under the limits the case was planned with. */
function tokensOf(item: EmbeddingItem, limits: ResolvedEmbeddingBatchLimits): number {
  return limits.estimateTokens(item.contentParts.map(part => part.text).join(''))
}

/**
 * Text long enough to be interesting and short enough to hit the small bounds
 * the cases use. Multi-byte runes are included so a byte limit cannot be
 * confused with a character count.
 */
function textOf(rng: Rng, length: number): string {
  const alphabet = 'abcdefghij0123 àéîõü漢字🙂'
  const runes = [...alphabet]
  let out = ''
  for (let i = 0; i < length; i += 1) out += runes[intBelow(rng, runes.length)] as string
  return out
}

/**
 * A corpus whose item sizes straddle the generated limits.
 *
 * One in roughly eight items is deliberately huge so the single-item overflow
 * batch — the planner's one documented exception — is exercised rather than
 * assumed unreachable.
 */
function itemsOf(rng: Rng, count: number): EmbeddingItem[] {
  const items: EmbeddingItem[] = []
  for (let index = 0; index < count; index += 1) {
    const oversized = intBelow(rng, 8) === 0
    const partCount = intBetween(rng, 1, 3)
    const parts: { readonly type: 'text'; readonly text: string }[] = []
    for (let p = 0; p < partCount; p += 1) {
      const length = oversized ? intBetween(rng, 200, 400) : intBetween(rng, 1, 30)
      parts.push({ type: 'text', text: textOf(rng, length) })
    }
    items.push({ index, contentParts: parts })
  }
  return items
}

/**
 * Limits small enough that all three bounds bind in the same run.
 *
 * `estimateTokens` stays the real shared heuristic: a test-local estimator could
 * agree with itself while disagreeing with the production split.
 */
function limitsOf(rng: Rng): ResolvedEmbeddingBatchLimits {
  return {
    maxItems: intBetween(rng, 1, 8),
    maxTokens: intBetween(rng, 4, 120),
    maxBytes: intBetween(rng, 16, 400),
    estimateTokens,
  }
}

/**
 * Yields to the macrotask queue so overlapping work is genuinely concurrent.
 *
 * `setImmediate` rather than `setTimeout(0)`: both are real task boundaries — so
 * every pending pull microtask drains before any batch finishes, which is what
 * makes saturation observable — but a timer's floor of a millisecond or so on
 * some platforms would put thousands of generated batches into minutes.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 5: Batch tôn trọng ba giới hạn và bộ nhớ bị chặn trên', () => {
  it('keeps every batch inside all three limits, partitions the corpus exactly once, and never reads the source ahead of consumption', () => {
    let sawOverflowBatch = false
    let sawMultiBatchPlan = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x5eed_0005 + run
      const rng = rngOf(seed)
      const limits = limitsOf(rng)
      const items = itemsOf(rng, intBetween(rng, 1, 40))
      const context = `seed=${seed} items=${items.length} limits=${JSON.stringify({
        maxItems: limits.maxItems,
        maxTokens: limits.maxTokens,
        maxBytes: limits.maxBytes,
      })}`

      // The corpus is exposed as a counting generator, so how far the planner
      // read is observable — that is the memory half of the property.
      let pulled = 0
      function* source(): Generator<EmbeddingItem> {
        for (const item of items) {
          pulled += 1
          yield item
        }
      }

      const plan = planEmbeddingBatches(source(), limits)
      const seen: EmbeddingItem[] = []
      const batches: EmbeddingBatchPlan[] = []

      for (;;) {
        const next = plan.next()
        if (next.done === true) break
        const batch = next.value
        batches.push(batch)
        seen.push(...batch.items)

        // Memory bound: at the moment a batch is yielded, the planner may hold
        // at most the item that closed it. Retained items are therefore bounded
        // by maxItems + 1 regardless of corpus size (Requirement 17.4).
        expect(pulled, `read ahead of consumption (${context})`).toBeLessThanOrEqual(
          seen.length + 1,
        )

        // A batch is never empty, and the item bound is absolute: unlike tokens
        // and bytes it has no overflow exception.
        expect(batch.items.length, `empty batch (${context})`).toBeGreaterThan(0)
        expect(
          batch.items.length,
          `maxItems exceeded (${context})`,
        ).toBeLessThanOrEqual(limits.maxItems)

        // Reported sizes must be the measured sizes, otherwise the limit checks
        // below would be self-confirming.
        const measuredTokens = batch.items.reduce((sum, i) => sum + tokensOf(i, limits), 0)
        const measuredBytes = batch.items.reduce((sum, i) => sum + bytesOf(i), 0)
        expect(batch.estimatedTokens, `token accounting (${context})`).toBe(measuredTokens)
        expect(batch.bytes, `byte accounting (${context})`).toBe(measuredBytes)

        if (batch.items.length === 1) {
          // The one deliberate exception: an item that alone breaches a size
          // bound still ships whole. What must NOT happen is content being cut.
          const only = batch.items[0] as EmbeddingItem
          const origin = items[only.index] as EmbeddingItem
          expect(only.contentParts, `content altered (${context})`).toEqual(
            origin.contentParts,
          )
          if (measuredTokens > limits.maxTokens || measuredBytes > limits.maxBytes) {
            sawOverflowBatch = true
          }
        } else {
          // Any batch the planner chose to grow must be inside both size bounds.
          expect(
            measuredTokens,
            `maxTokens exceeded (${context})`,
          ).toBeLessThanOrEqual(limits.maxTokens)
          expect(measuredBytes, `maxBytes exceeded (${context})`).toBeLessThanOrEqual(
            limits.maxBytes,
          )
        }
      }

      if (batches.length > 1) sawMultiBatchPlan = true

      // Exact partition, in input order, with no duplicate and no dropped item.
      expect(seen.length, `partition size (${context})`).toBe(items.length)
      expect(
        seen.map((i) => i.index),
        `partition identity/order (${context})`,
      ).toEqual(items.map((i) => i.index))
      expect(
        batches.map((b) => b.batchIndex),
        `batchIndex sequence (${context})`,
      ).toEqual(batches.map((_, position) => position))
      expect(pulled, `source not fully consumed (${context})`).toBe(items.length)
    }

    // Non-vacuity: the generated space really did reach both interesting shapes.
    expect(sawMultiBatchPlan, 'no case produced more than one batch').toBe(true)
    expect(sawOverflowBatch, 'no case produced a single-item overflow batch').toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 6: Số batch chạy đồng thời không vượt cấu hình', () => {
  it('never exceeds the configured in-flight bound and never materialises more batches than slots', async () => {
    let sawSaturation = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x5eed_0006 + run
      const rng = rngOf(seed)
      const configured = intBelow(rng, 5) === 0 ? undefined : intBetween(rng, 1, 6)
      const limit = configured ?? DEFAULT_EMBEDDING_CONCURRENCY
      const batchCount = intBetween(rng, 0, 14)
      const work = Array.from({ length: batchCount }, (_, i) => i)
      const context = `seed=${seed} concurrency=${String(configured)} batches=${batchCount}`

      expect(resolveEmbeddingConcurrency(configured), `resolved bound (${context})`).toBe(
        limit,
      )

      let materialised = 0
      let settled = 0
      let inFlight = 0
      let peakInFlight = 0
      let peakLive = 0
      const ordinals: number[] = []

      function* source(): Generator<number> {
        for (const batch of work) {
          materialised += 1
          // Batches pulled but not yet settled are the payloads alive at once;
          // this is the quantity Requirement 17.4 bounds.
          peakLive = Math.max(peakLive, materialised - settled)
          yield batch
        }
      }

      const outcome = await runBatchesWithConcurrency(
        source(),
        async (batch, ordinal) => {
          inFlight += 1
          peakInFlight = Math.max(peakInFlight, inFlight)
          ordinals.push(ordinal)
          // A real task boundary, so slots genuinely overlap instead of the
          // callback completing before the next pull can happen. The count
          // varies so completion order is not uniform.
          for (let t = 0; t < intBetween(rng, 1, 3); t += 1) await tick()
          expect(inFlight, `bound breached mid-flight (${context})`).toBeLessThanOrEqual(
            limit,
          )
          expect(batch, `batch payload altered (${context})`).toBe(work[ordinal])
          inFlight -= 1
          settled += 1
        },
        // Spread conditionally: "option absent" and "option present as
        // undefined" are different inputs under exactOptionalPropertyTypes, and
        // this case deliberately exercises the absent one.
        configured === undefined ? {} : { concurrency: configured },
      )

      expect(peakInFlight, `peak in-flight (${context})`).toBeLessThanOrEqual(limit)
      expect(peakLive, `peak materialised payloads (${context})`).toBeLessThanOrEqual(limit)
      expect(outcome.started, `started count (${context})`).toBe(batchCount)
      expect(outcome.aborted, `unexpected abort (${context})`).toBe(false)
      expect(settled, `settled count (${context})`).toBe(batchCount)
      expect(
        [...ordinals].sort((a, b) => a - b),
        `ordinals (${context})`,
      ).toEqual(work)

      if (batchCount >= limit && peakInFlight === limit) sawSaturation = true
    }

    // Without this, a runner that executed every batch serially would satisfy
    // an upper bound trivially.
    expect(sawSaturation, 'no case ever filled its slots').toBe(true)
  })

  it('bounds in-flight batches for a plan produced by the lazy planner', async () => {
    let sawSaturation = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x5eed_0016 + run
      const rng = rngOf(seed)
      const limits = limitsOf(rng)
      const items = itemsOf(rng, intBetween(rng, 1, 30))
      const concurrency = intBetween(rng, 1, 5)
      const context = `seed=${seed} concurrency=${concurrency} items=${items.length}`

      let pulledItems = 0
      function* source(): Generator<EmbeddingItem> {
        for (const item of items) {
          pulledItems += 1
          yield item
        }
      }

      let inFlight = 0
      let peakInFlight = 0
      const embedded: number[] = []

      const outcome = await runBatchesWithConcurrency(
        planEmbeddingBatches(source(), limits),
        async (batch: EmbeddingBatchPlan) => {
          inFlight += 1
          peakInFlight = Math.max(peakInFlight, inFlight)
          for (const item of batch.items) embedded.push(item.index)
          await tick()
          inFlight -= 1
        },
        { concurrency },
      )

      expect(peakInFlight, `peak in-flight (${context})`).toBeLessThanOrEqual(concurrency)
      expect(outcome.aborted, `unexpected abort (${context})`).toBe(false)
      expect(pulledItems, `source fully consumed (${context})`).toBe(items.length)
      // End to end the composition is still an exact partition of the corpus.
      expect(
        [...embedded].sort((a, b) => a - b),
        `partition (${context})`,
      ).toEqual(items.map((i) => i.index))

      if (outcome.started >= concurrency && peakInFlight === concurrency) {
        sawSaturation = true
      }
    }

    expect(sawSaturation, 'no planned case ever filled its slots').toBe(true)
  })
})
