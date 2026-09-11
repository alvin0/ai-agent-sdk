/**
 * Property and unit tests for pre-dispatch embedding request validation.
 *
 * Feature: embedding-support, Property 2: Vi phạm khai báo bị từ chối trước khi
 * có bất kỳ Provider_Attempt.
 *
 * **Validates: Requirements 3.6, 7.2, 9.1, 9.2, 9.7**
 *
 * The claim under test has two halves, and the second is the one that is easy to
 * assert vacuously. So every rejection here runs through a real
 * `PreparedEmbeddingCall` built by a real `EmbeddingAdapter` whose `embedBatch`
 * increments a counter: a rejection is only accepted as pre-dispatch when that
 * counter reads 0 afterwards. The same harness dispatches the accepted cases, so
 * the counter is proven to be capable of reaching 1 — a broken adapter stub
 * cannot make the zero-attempt assertion pass for free.
 *
 * The third half, which the property text states as a boundary rather than a
 * rejection, is DD-6: an `unknown` capability is never a reason to reject. Each
 * declared violation is therefore re-run against a catalog entry that declares
 * nothing, and there the SAME request must reach the provider.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/validation.spec.ts`. No
 * runner collects that directory — root `vitest.config.ts` includes `tests/**`,
 * and the package configs reach into the ROOT `tests/` tree by relative path. A
 * spec there would never run in CI, the one failure mode a property test must
 * not have. It sits beside `tests/unit/embedding/profile.spec.ts` instead.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The established
 * convention (see `tests/unit/embedding/profile.spec.ts`) is a seeded mulberry32
 * generator: a failure reproduces from the printed seed and no dependency enters
 * the graph for test-only reasons. Each property runs `RUNS` cases, above the
 * spec floor of 100.
 */

import { describe, expect, it } from 'vitest'
import { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import type { PreparedEmbeddingCall } from '../../../packages/core/src/embedding/adapter.ts'
import {
  unknownEmbeddingModel,
  type EmbeddingCapability,
  type ResolvedEmbeddingModelInfo,
} from '../../../packages/core/src/embedding/catalog.ts'
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
} from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingSpaceId } from '../../../packages/core/src/embedding/profile.ts'
import type {
  EmbeddingBatchRequest,
  EmbeddingItem,
  EmbeddingTruncation,
} from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import {
  validatePreDispatch,
  type PreDispatchRequest,
} from '../../../packages/core/src/embedding/validation.ts'

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

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

const PROVIDERS = ['openai', 'gemini', 'self-hosted'] as const

const MODEL_IDS = [
  'text-embedding-3-small',
  'gemini-embedding-001',
  'bge-m3',
  'not-in-any-catalog',
] as const

/** Widths a route may declare; the generated `supported` list is a subset. */
const DIMENSION_POOL = [128, 256, 512, 768, 1024, 1536, 3072] as const

/**
 * Declared per-input token ceilings, kept small on purpose.
 *
 * `estimateTokens` is `ceil(utf8Bytes / 4)`, so a small ceiling makes both the
 * conforming and the oversized text cheap to build exactly at the boundary.
 */
const TOKEN_LIMITS = [4, 16, 64, 256] as const

const PURPOSES: readonly EmbeddingPurpose[] = ['retrieval-query', 'retrieval-document']

/** Values a caller could pass where an `EmbeddingPurpose` belongs. */
const INVALID_PURPOSES = [
  '',
  'retrieval',
  'query',
  'document',
  'RETRIEVAL-QUERY',
  'retrieval-query ',
  'classification',
  'similarity',
] as const

const TRUNCATIONS: readonly EmbeddingTruncation[] = ['reject', 'allow']

/** ASCII text, so `utf8Bytes === length` and token counts are exact. */
function asciiOfBytes(bytes: number): string {
  return 'a'.repeat(bytes)
}

/** An item whose estimate is at most `limit` tokens. */
function conformingItem(rng: Rng, index: number, limit: number): EmbeddingItem {
  const bytes = intBetween(rng, 1, limit * 4)
  return { index, contentParts: [{ type: 'text', text: asciiOfBytes(bytes) }] }
}

/** An item whose estimate strictly exceeds `limit` tokens. */
function oversizedItem(rng: Rng, index: number, limit: number): EmbeddingItem {
  const bytes = limit * 4 + intBetween(rng, 1, 4 * limit)
  return { index, contentParts: [{ type: 'text', text: asciiOfBytes(bytes) }] }
}

// ---------------------------------------------------------------------------
// A counting adapter: the evidence for "zero Provider_Attempt"
// ---------------------------------------------------------------------------

/**
 * Minimal `EmbeddingAdapter` that counts physical dispatches.
 *
 * Deliberately inline rather than shared: this file's whole argument rests on
 * the counter, so the counter must be readable next to the assertions that use
 * it.
 */
class CountingEmbeddingAdapter extends EmbeddingAdapter {
  /** Number of `Provider_Attempt`s this adapter has performed. */
  attempts = 0

  constructor(private readonly info: ResolvedEmbeddingModelInfo) {
    super()
  }

  override resolveEmbeddingModel(): Promise<ResolvedEmbeddingModelInfo> {
    return Promise.resolve(this.info)
  }

  override embedBatch(batch: EmbeddingBatchRequest): Promise<EmbeddingBatchResult> {
    this.attempts += 1
    const width = batch.dimensions ?? 3
    return Promise.resolve({
      vectors: batch.items.map((item) => ({
        index: item.index,
        values: Array.from({ length: width }, () => 0),
      })),
    })
  }
}

/** A route that declares widths, a token ceiling and a compatibility identity. */
function declaringModel(
  rng: Rng,
  options: { readonly dimensions: readonly number[]; readonly maxInputTokens: number },
): ResolvedEmbeddingModelInfo {
  const provider = pick(rng, PROVIDERS)
  const id = pick(rng, MODEL_IDS)
  return {
    ...unknownEmbeddingModel(provider, id),
    inputTypes: { state: 'supported', value: ['text'] },
    representation: { state: 'supported', value: 'dense-float32' },
    dimensions: { state: 'supported', value: options.dimensions },
    defaultDimensions: { state: 'supported', value: options.dimensions[0] as number },
    maxInputTokens: { state: 'supported', value: options.maxInputTokens },
    compatibilityIdentity: { state: 'supported', value: `${provider}:${id}-space` },
  }
}

/** A route outside the catalog: identity only, every capability `unknown`. */
function silentModel(rng: Rng): ResolvedEmbeddingModelInfo {
  return unknownEmbeddingModel(pick(rng, PROVIDERS), pick(rng, MODEL_IDS))
}

async function prepare(
  model: ResolvedEmbeddingModelInfo,
  dimensions: number | undefined,
): Promise<{ adapter: CountingEmbeddingAdapter; prepared: PreparedEmbeddingCall }> {
  const adapter = new CountingEmbeddingAdapter(model)
  const prepared = await adapter.prepareEmbeddingCall(
    model.provider,
    model.id,
    dimensions === undefined ? {} : { dimensions },
  )
  return { adapter, prepared }
}

/**
 * Runs one `Logical_Call` the way the runtime will: validate first, dispatch
 * only if validation returned.
 *
 * Nothing between the two steps, so an attempt counted after this resolves or
 * rejects is unambiguously attributable to validation having let the call
 * through.
 */
async function runLogicalCall(
  request: PreDispatchRequest,
  prepared: PreparedEmbeddingCall,
): Promise<void> {
  validatePreDispatch(request, prepared)
  await prepared.embedBatch({
    provider: prepared.model.provider,
    model: prepared.model.id,
    purpose: request.purpose,
    items: request.items,
    ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
    truncation: request.truncation,
  })
}

/** What a rejection must carry, beyond its code. */
interface ExpectedRejection {
  readonly code: string
  /** Exact expected indexes; `undefined` means "not asserted". */
  readonly itemIndexes?: readonly number[]
  /** Exact expected applied limit. */
  readonly limit?: number
  /** Whether the failure must name the prepared call's space. */
  readonly space?: boolean
}

/**
 * Asserts one request is rejected before dispatch, with the right code, the
 * right attribution facts, and a provider attempt count of exactly 0.
 */
async function expectRejectedBeforeDispatch(
  model: ResolvedEmbeddingModelInfo,
  request: PreDispatchRequest,
  expected: ExpectedRejection,
): Promise<void> {
  const { adapter, prepared } = await prepare(model, request.dimensions)

  let caught: unknown
  try {
    await runLogicalCall(request, prepared)
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(EmbeddingError)
  const error = caught as EmbeddingError
  expect(error.code).toBe(expected.code)
  // The half of the property that a message assertion cannot establish.
  expect(adapter.attempts).toBe(0)
  // No raw input text leaks into the failure a caller will log. Only texts long
  // enough to be distinguishable from ordinary message characters are checked.
  for (const item of request.items) {
    for (const part of item.contentParts) {
      if (part.text.length >= 16) expect(error.message).not.toContain(part.text)
    }
  }
  if (expected.itemIndexes !== undefined) {
    expect(error.itemIndexes).toEqual(expected.itemIndexes)
  }
  if (expected.limit !== undefined) {
    expect(error.limit).toBe(expected.limit)
  }
  if (expected.space === true) {
    expect(error.space).toBe(prepared.spaceId)
  }
  expect(error.provider).toBe(model.provider)
  expect(error.model).toBe(model.id)
}

/** Asserts one request passes validation and reaches the provider exactly once. */
async function expectDispatched(
  model: ResolvedEmbeddingModelInfo,
  request: PreDispatchRequest,
): Promise<void> {
  const { adapter, prepared } = await prepare(model, request.dimensions)
  await runLogicalCall(request, prepared)
  expect(adapter.attempts).toBe(1)
}

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 2: Vi phạm khai báo bị từ chối trước khi có bất kỳ Provider_Attempt', () => {
  it('rejects every declared violation with zero provider attempts', async () => {
    const rng = rngOf(0x2c3d_4e5f)

    for (let run = 0; run < RUNS; run += 1) {
      const limit = pick(rng, TOKEN_LIMITS)
      const supportedWidths = [pick(rng, DIMENSION_POOL), pick(rng, DIMENSION_POOL)]
      const model = declaringModel(rng, {
        dimensions: supportedWidths,
        maxInputTokens: limit,
      })
      const itemCount = intBetween(rng, 1, 5)
      const items = Array.from({ length: itemCount }, (_unused, index) =>
        conformingItem(rng, index, limit),
      )
      const base: PreDispatchRequest = {
        purpose: pick(rng, PURPOSES),
        items,
        dimensions: pick(rng, supportedWidths),
        truncation: pick(rng, TRUNCATIONS),
        truncationSupport: { state: 'supported', value: true },
      }

      // Guard against a vacuous property: the conforming request must reach the
      // provider, so a zero count below is a decision and not a broken harness.
      await expectDispatched(model, base)

      // Requirement 7.2 — purpose outside the two declared values.
      await expectRejectedBeforeDispatch(
        model,
        { ...base, purpose: pick(rng, INVALID_PURPOSES) as EmbeddingPurpose },
        { code: EMBEDDING_ERROR_CODES.REQUEST_INVALID },
      )

      // Requirement 9.2 — a width outside the declared list.
      const undeclaredWidth = pick(
        rng,
        DIMENSION_POOL.filter((width) => !supportedWidths.includes(width)),
      )
      await expectRejectedBeforeDispatch(
        model,
        { ...base, dimensions: undeclaredWidth },
        { code: EMBEDDING_ERROR_CODES.DIMENSIONS_UNSUPPORTED },
      )

      // Requirement 9.1 — inputs over the declared ceiling, named individually
      // together with the applied limit, so the caller can re-chunk just those.
      const oversizedIndexes = items
        .map((item) => item.index)
        .filter(() => rng() < 0.5)
      const targeted = oversizedIndexes.length > 0 ? oversizedIndexes : [items[0]!.index]
      await expectRejectedBeforeDispatch(
        model,
        {
          ...base,
          items: items.map((item) =>
            targeted.includes(item.index) ? oversizedItem(rng, item.index, limit) : item,
          ),
        },
        {
          code: EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE,
          itemIndexes: targeted,
          limit,
        },
      )

      // Requirement 9.7 — `allow` against a route that states it has no
      // truncation parameter at all.
      await expectRejectedBeforeDispatch(
        model,
        { ...base, truncation: 'allow', truncationSupport: { state: 'unsupported' } },
        { code: EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED },
      )

      // Requirement 3.6's sibling: an incompatible expected space is also
      // settled before the first batch, and names the space it settled against.
      await expectRejectedBeforeDispatch(
        model,
        { ...base, expectedSpace: 'emb:1|not-this-space|1|x|y|none|1' as EmbeddingSpaceId },
        { code: EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE, space: true },
      )

      // Malformed at the SDK boundary, independent of any declaration.
      await expectRejectedBeforeDispatch(
        model,
        { ...base, items: [] },
        { code: EMBEDDING_ERROR_CODES.REQUEST_INVALID },
      )
      const blankIndex = pick(rng, items).index
      await expectRejectedBeforeDispatch(
        model,
        {
          ...base,
          items: items.map((item) =>
            item.index === blankIndex
              ? { index: item.index, contentParts: [{ type: 'text' as const, text: '' }] }
              : item,
          ),
        },
        { code: EMBEDDING_ERROR_CODES.REQUEST_INVALID, itemIndexes: [blankIndex] },
      )
      await expectRejectedBeforeDispatch(
        model,
        { ...base, dimensions: pick(rng, [0, -1, -768, 1.5, Number.NaN]) },
        { code: EMBEDDING_ERROR_CODES.REQUEST_INVALID },
      )
    }
  })

  it('never rejects on an undeclared capability, and dispatches instead (DD-6)', async () => {
    const rng = rngOf(0x6a7b_8c9d)

    for (let run = 0; run < RUNS; run += 1) {
      const model = silentModel(rng)
      const itemCount = intBetween(rng, 1, 5)
      // Text far past every ceiling in TOKEN_LIMITS: with `maxInputTokens`
      // unknown there is no declared bound to measure it against, and the
      // batching fallbacks are not a claim the provider made.
      const items = Array.from({ length: itemCount }, (_unused, index) =>
        oversizedItem(rng, index, pick(rng, TOKEN_LIMITS)),
      )
      const request: PreDispatchRequest = {
        purpose: pick(rng, PURPOSES),
        items,
        // A width no catalog lists, on a route that declares no width at all.
        dimensions: intBetween(rng, 1, 8192),
        truncation: 'allow',
        // The two states that state nothing: absent, and explicitly `unknown`.
        ...(rng() < 0.5 ? {} : { truncationSupport: { state: 'unknown' as const } }),
      }

      await expectDispatched(model, request)
    }
  })

  it('never rejects when a route declares it has no such limit', async () => {
    const rng = rngOf(0x0d1e_2f30)

    for (let run = 0; run < RUNS; run += 1) {
      const unsupported: EmbeddingCapability<never> = { state: 'unsupported' }
      const model: ResolvedEmbeddingModelInfo = {
        ...silentModel(rng),
        // `unsupported` is a positive negative claim about HAVING a ceiling, so
        // there is still no number to measure an input against.
        maxInputTokens: unsupported,
        dimensions: unsupported,
      }
      const items = Array.from({ length: intBetween(rng, 1, 4) }, (_unused, index) =>
        oversizedItem(rng, index, pick(rng, TOKEN_LIMITS)),
      )

      await expectDispatched(model, {
        purpose: pick(rng, PURPOSES),
        items,
        dimensions: pick(rng, DIMENSION_POOL),
        truncation: pick(rng, TRUNCATIONS),
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('validatePreDispatch', () => {
  const model: ResolvedEmbeddingModelInfo = {
    ...unknownEmbeddingModel('openai', 'text-embedding-3-small'),
    dimensions: { state: 'supported', value: [256, 1536] },
    defaultDimensions: { state: 'supported', value: 1536 },
    maxInputTokens: { state: 'supported', value: 8 },
    compatibilityIdentity: { state: 'supported', value: 'openai:embedding-v3-space' },
  }

  function itemOf(index: number, text: string): EmbeddingItem {
    return { index, contentParts: [{ type: 'text', text }] }
  }

  it('measures an input at the declared boundary as conforming', async () => {
    // 32 ASCII bytes is exactly 8 estimated tokens: the ceiling is inclusive,
    // so the boundary input must dispatch rather than be rejected.
    await expectDispatched(model, {
      purpose: 'retrieval-query',
      items: [itemOf(0, asciiOfBytes(32))],
      dimensions: 256,
      truncation: 'reject',
    })
  })

  it('rejects one byte past the declared boundary, naming the index and limit', async () => {
    await expectRejectedBeforeDispatch(
      model,
      {
        purpose: 'retrieval-query',
        items: [itemOf(0, asciiOfBytes(32)), itemOf(1, asciiOfBytes(33))],
        truncation: 'reject',
      },
      { code: EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE, itemIndexes: [1], limit: 8 },
    )
  })

  it('sums content parts of one item against the per-input ceiling', async () => {
    // Four parts of 9 bytes: 36 bytes, 9 tokens, over the ceiling of 8. Parts
    // belong to the SAME object, so they are measured together.
    await expectRejectedBeforeDispatch(
      model,
      {
        purpose: 'retrieval-document',
        items: [
          {
            index: 0,
            contentParts: Array.from({ length: 4 }, () => ({
              type: 'text' as const,
              text: asciiOfBytes(9),
            })),
          },
        ],
        truncation: 'reject',
      },
      { code: EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE, itemIndexes: [0], limit: 8 },
    )
  })

  it('accepts a compatible expected space and rejects an incompatible one', async () => {
    const { prepared } = await prepare(model, 256)

    await expectDispatched(model, {
      purpose: 'retrieval-query',
      items: [itemOf(0, 'hello')],
      dimensions: 256,
      truncation: 'reject',
      expectedSpace: prepared.spaceId,
      expectedProfile: prepared.profile,
    })

    await expectRejectedBeforeDispatch(
      model,
      {
        purpose: 'retrieval-query',
        items: [itemOf(0, 'hello')],
        dimensions: 256,
        truncation: 'reject',
        expectedProfile: { ...prepared.profile, dimensions: 1536 },
      },
      { code: EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE, space: true },
    )
  })

  it('leaves truncation "reject" alone on a route with no truncation parameter', async () => {
    // Only `allow` promises behaviour the wire cannot express.
    await expectDispatched(model, {
      purpose: 'retrieval-query',
      items: [itemOf(0, 'hello')],
      dimensions: 1536,
      truncation: 'reject',
      truncationSupport: { state: 'unsupported' },
    })
  })

  it('reports every empty item at once rather than the first', async () => {
    await expectRejectedBeforeDispatch(
      model,
      {
        purpose: 'retrieval-document',
        items: [itemOf(0, ''), itemOf(1, 'ok'), { index: 2, contentParts: [] }],
        truncation: 'reject',
      },
      { code: EMBEDDING_ERROR_CODES.REQUEST_INVALID, itemIndexes: [0, 2] },
    )
  })

  it('checks a malformed request before it pays for token estimation', async () => {
    // An invalid purpose short-circuits, so a limits object that would throw if
    // consulted proves the length check never ran.
    const { adapter, prepared } = await prepare(model, 256)
    const exploding: PreparedEmbeddingCall = {
      ...prepared,
      limits: {
        ...prepared.limits,
        estimateTokens: () => {
          throw new Error('estimateTokens must not run for a malformed request')
        },
      },
    }

    expect(() =>
      validatePreDispatch(
        {
          purpose: 'classification' as EmbeddingPurpose,
          items: [itemOf(0, asciiOfBytes(4096))],
          truncation: 'reject',
        },
        exploding,
      ),
    ).toThrow(EmbeddingError)
    expect(adapter.attempts).toBe(0)
  })
})
