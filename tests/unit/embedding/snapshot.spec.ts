/**
 * Property tests for the per-`Logical_Call` configuration snapshot.
 *
 * Feature: embedding-support, Property 1: Snapshot cấu hình bất biến trong một
 * Logical_Call — and Property 32: Connection snapshot đúng một lần cho mỗi
 * operation.
 *
 * **Validates: Requirements 2.2, 2.3, 2.4, 13.1**
 *
 * ## What is actually being claimed
 *
 * Both properties are about a WINDOW, not about a value: the window between the
 * moment `prepareEmbeddingCall()` captures a generation and the moment the last
 * `Physical_Batch` of that `Logical_Call` settles. Inside that window the route
 * configuration is allowed to change — a credential rotation, a catalog reload, a
 * revised compatibility identity — and none of it may become visible to the call
 * in flight. So every test here CHANGES the configuration mid-call and then asks
 * whether the call still behaved as the snapshot said it would:
 *
 * - **one snapshot per logical call** — `prepareEmbeddingCall()` is invoked
 *   exactly once, and every dispatch, retry included, goes through that one
 *   generation's `embedBatch` (Requirement 2.2);
 * - **checks read the snapshot** — the dimensions check, the per-input token
 *   ceiling, and the batch bounds are all read from the captured metadata, so a
 *   configuration that would now allow (or now forbid) the request changes
 *   nothing (Requirements 2.3, 2.4);
 * - **the reported `Space_Id` is the snapshot's** — the call publishes the space
 *   it actually produced vectors in, never the space a later configuration would
 *   produce (Requirement 2.4);
 * - **one connection snapshot per operation** — however many physical batches one
 *   prepared call fans out into, the transport captures its connection once
 *   (Requirement 13.1, Property 32).
 *
 * ## How a wrong implementation is caught rather than assumed
 *
 * A test that mutates configuration and then asserts success proves nothing
 * unless the mutation would have been observable. So each mutation is chosen to
 * flip an outcome:
 *
 * - the dimensions list moves to one that does NOT contain the requested width,
 *   so a live read would reject a call that must succeed — and the mirrored
 *   negative test starts from a forbidding list and moves to a permitting one, so
 *   a live read would ACCEPT a call that must be rejected with zero attempts;
 * - `maxBatchItems` grows mid-call, so a live read would emit wider batches than
 *   the observed ones;
 * - `compatibilityIdentity` changes, so a live read would publish a different
 *   `Space_Id` — the property re-prepares after the call and asserts the second
 *   generation really does derive a different id, which is what makes the first
 *   assertion non-vacuous;
 * - the connection's credential rotates on every dispatch, so a per-batch capture
 *   would hand out a different header set than the one every batch observed.
 *
 * ## Property 32 and the transport half
 *
 * `captureTransportConnection` lives in `packages/provider-http`, and the real
 * embedding-over-HTTP adapters are later tasks. What can be pinned NOW is the
 * embedding-side claim: an `EmbeddingAdapter` that snapshots its connection in
 * `prepareEmbeddingCall()` — which is the one hook the runtime calls once per
 * `Logical_Call` — captures once no matter how the call fans out. The adapter here
 * uses the REAL `captureTransportConnection`, not a stand-in, so the merge and
 * freeze semantics under test are the shipped ones; what the test owns is the
 * call-count claim, and that count is a property of the runtime's dispatch shape.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/snapshot.spec.ts`. No
 * runner collects that directory: root `vitest.config.ts` includes `tests/**`, and
 * the package configs reach into the ROOT `tests/` tree by relative path. It sits
 * beside `tests/unit/embedding/{order,planner,retry,usage}.spec.ts`, which
 * document the same deviation.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the sibling
 * embedding specs use a seeded mulberry32 generator: a failure reproduces from the
 * printed seed and nothing test-only enters the dependency graph. `RUNS` is above
 * the spec floor of 100.
 *
 * @module tests/unit/embedding/snapshot.spec
 */

import { describe, expect, it } from 'vitest'
import {
  createEmbeddingModelHandle,
  type EmbeddingHandleOptions,
  type EmbeddingOperationScheduler,
} from '../../../packages/core/src/composition/embedding/handle.ts'
import { resolveRetryPolicy } from '../../../packages/core/src/contract/retry-policy.ts'
import type { PreparedEmbeddingCall, PrepareEmbeddingOptions } from '../../../packages/core/src/embedding/adapter.ts'
import type { ResolvedEmbeddingModelInfo } from '../../../packages/core/src/embedding/catalog.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheStore,
} from '../../../packages/core/src/embedding/handle.ts'
import { deriveSpaceId } from '../../../packages/core/src/embedding/profile.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import type { EmbeddingBatchRequest } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import type { OperationLease, OperationOptions } from '../../../packages/core/src/composition/lifecycle/types.ts'
import {
  captureTransportConnection,
  type HttpTransportConnection,
} from '../../../packages/provider-http/src/transport/connection.ts'
import {
  FakeEmbeddingAdapter,
  fakeEmbeddingModel,
  supported,
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

// ---------------------------------------------------------------------------
// Runtime admission double
// ---------------------------------------------------------------------------

/**
 * The narrowest thing the handle accepts: one lease whose signal fuses the
 * caller's.
 *
 * Standing up a whole `RuntimeOperations` would drag close semantics into a test
 * about snapshots; the handle's dependency is structural precisely so this can be
 * a dozen lines. `tests/unit/embedding/lifecycle.spec.ts` owns close behaviour.
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

const RETRY_POLICY = resolveRetryPolicy(
  { mode: 'normal', maxRetries: 3, backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } },
  'test.retryPolicy',
)

// ---------------------------------------------------------------------------
// A route whose configuration can change under the call
// ---------------------------------------------------------------------------

/**
 * The mutable half of a provider route.
 *
 * These are exactly the facts a snapshot is supposed to pin: what the catalog
 * declares about widths, per-input length, batch bounds, and — the one that
 * decides the published space — the compatibility identity.
 */
interface RouteConfig {
  /** Declared selectable widths; `undefined` leaves the capability `unknown`. */
  readonly dimensions?: readonly number[]
  readonly defaultDimensions?: number
  readonly maxInputTokens?: number
  readonly maxBatchItems?: number
  readonly compatibilityIdentity: string
}

/** Catalog metadata as the route would resolve it from a given configuration. */
function modelOf(
  provider: string,
  model: string,
  config: RouteConfig,
): ResolvedEmbeddingModelInfo {
  return fakeEmbeddingModel(provider, model, {
    compatibilityIdentity: supported(config.compatibilityIdentity),
    ...(config.dimensions === undefined ? {} : { dimensions: supported(config.dimensions) }),
    ...(config.defaultDimensions === undefined
      ? {}
      : { defaultDimensions: supported(config.defaultDimensions) }),
    ...(config.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: supported(config.maxInputTokens) }),
    ...(config.maxBatchItems === undefined
      ? {}
      : { maxBatchItems: supported(config.maxBatchItems) }),
  })
}

/** One recorded dispatch, tagged with the generation it travelled through. */
interface DispatchRecord {
  readonly generation: number
  readonly itemIndexes: readonly number[]
}

/**
 * A `FakeEmbeddingAdapter` whose route configuration is a mutable field.
 *
 * Three hooks make the mid-call window observable:
 *
 * - `resolveEmbeddingModel()` reads the CURRENT configuration, so a snapshot is
 *   only as good as the moment it was taken;
 * - `prepareEmbeddingCall()` records each generation, then fires `onCaptured` —
 *   a configuration change landing immediately AFTER the capture and therefore
 *   before pre-dispatch validation, which is the earliest place a live read could
 *   leak;
 * - the wrapped `embedBatch` records which generation dispatched, then fires
 *   `onDispatch` — a configuration change landing between batches of one call.
 */
class SnapshotAdapter extends FakeEmbeddingAdapter {
  /** Live route configuration; tests reassign this field mid-call. */
  config: RouteConfig
  /** One entry per `prepareEmbeddingCall()`; the property asserts exactly one. */
  readonly generations: PreparedEmbeddingCall[] = []
  /** One entry per dispatch through a prepared call, retries included. */
  readonly dispatches: DispatchRecord[] = []
  /** Fires right after a generation is captured. */
  onCaptured?: (generation: number) => void
  /** Fires on each dispatch, before the provider responds. */
  onDispatch?: (ordinal: number) => void

  /** Failing attempts per batch, keyed by the batch's first item index. */
  private readonly failures: ReadonlyMap<number, number>
  private readonly attemptsPerBatch = new Map<number, number>()

  constructor(config: RouteConfig, failures: ReadonlyMap<number, number> = new Map()) {
    super({ dimensions: config.defaultDimensions ?? 4 })
    this.config = config
    this.failures = failures
  }

  override resolveEmbeddingModel(
    provider: string,
    model: string,
  ): Promise<ResolvedEmbeddingModelInfo> {
    return Promise.resolve(modelOf(provider, model, this.config))
  }

  override async prepareEmbeddingCall(
    provider: string,
    model: string,
    options: PrepareEmbeddingOptions,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedEmbeddingCall> {
    const base = await super.prepareEmbeddingCall(provider, model, options, signal, context)
    const generation = this.generations.length + 1
    this.generations.push(base)
    // The configuration moves the instant the snapshot is taken, so anything that
    // re-reads it afterwards — validation, planning, dispatch — is caught.
    this.onCaptured?.(generation)
    return Object.freeze({
      ...base,
      embedBatch: (batch: EmbeddingBatchRequest, invocation?: ModelInvocationContext) => {
        this.dispatches.push({
          generation,
          itemIndexes: Object.freeze(batch.items.map(item => item.index)),
        })
        this.onDispatch?.(this.dispatches.length)
        return base.embedBatch(batch, invocation)
      },
    })
  }

  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const key = batch.items[0]?.index ?? -1
    const attempt = (this.attemptsPerBatch.get(key) ?? 0) + 1
    this.attemptsPerBatch.set(key, attempt)
    if (attempt <= (this.failures.get(key) ?? 0)) {
      // Retryable under the policy above, so this batch comes back later — after
      // the configuration has moved further.
      throw new ModelError('scripted transient failure', MODEL_ERROR_CODES.SERVER)
    }
    return super.embedBatch(batch, context)
  }
}

// ---------------------------------------------------------------------------
// Expectations computed independently of the code under test
// ---------------------------------------------------------------------------

/**
 * Greedy batch sizes for `count` items under an item-count bound.
 *
 * Written out rather than borrowed from `planEmbeddingBatches` on purpose: the
 * claim is that batching used the SNAPSHOT's bound, so the expectation must come
 * from the bound, not from the planner. Generated texts are short and the token
 * and byte bounds stay at their defaults, so `maxItems` is the only bound that
 * can bind.
 */
function expectedBatchSizes(count: number, maxItems: number): readonly number[] {
  const sizes: number[] = []
  for (let remaining = count; remaining > 0; remaining -= maxItems) {
    sizes.push(Math.min(maxItems, remaining))
  }
  return sizes
}

/** An in-process cache store, plus a count of the reads that hit. */
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

const PURPOSES: readonly EmbeddingPurpose[] = Object.freeze([
  'retrieval-query',
  'retrieval-document',
])

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

/** One generated `Logical_Call` plus the configuration drift under it. */
interface GeneratedCase {
  readonly values: readonly string[]
  readonly purpose: EmbeddingPurpose
  readonly dimensions: number
  readonly initial: RouteConfig
  /** Applied immediately after the snapshot is captured. */
  readonly afterCapture: RouteConfig
  /** Applied on the dispatch with this 1-based ordinal, when there is one. */
  readonly driftAtDispatch: number
  readonly afterDrift: RouteConfig
  readonly concurrency: number
  readonly failures: ReadonlyMap<number, number>
}

function generateCase(rng: Rng, seed: number): GeneratedCase {
  const itemCount = 1 + intBelow(rng, 12)
  const values = Array.from(
    { length: itemCount },
    (_value, index) => `snapshot-${seed}/item-${index}`,
  )
  const dimensions = 2 + intBelow(rng, 4)
  const maxBatchItems = 1 + intBelow(rng, 4)
  const identity = `space-${seed}-a`

  const initial: RouteConfig = {
    // Contains the requested width, so the call is legal under the snapshot.
    dimensions: [dimensions],
    defaultDimensions: dimensions,
    // Generous enough that no generated input is over-long under the snapshot.
    maxInputTokens: 4_096,
    maxBatchItems,
    compatibilityIdentity: identity,
  }
  // Every field moves to a value that would flip an outcome if it were read live:
  // a width the request does not use, a ceiling every input exceeds, a wider
  // batch bound, and a different space.
  const afterCapture: RouteConfig = {
    dimensions: [dimensions + 1],
    defaultDimensions: dimensions + 1,
    maxInputTokens: 1,
    maxBatchItems: maxBatchItems + 1 + intBelow(rng, 4),
    compatibilityIdentity: `space-${seed}-b`,
  }
  const afterDrift: RouteConfig = {
    ...afterCapture,
    maxBatchItems: maxBatchItems + 5,
    compatibilityIdentity: `space-${seed}-c`,
  }

  const failures = new Map<number, number>()
  for (let index = 0; index < itemCount; index += maxBatchItems) {
    // Kept to one retry: each failure costs a real backoff sleep.
    if (rng() < 0.3) failures.set(index, 1)
  }

  return {
    values,
    purpose: pick(rng, PURPOSES),
    dimensions,
    initial,
    afterCapture,
    driftAtDispatch: 1 + intBelow(rng, 3),
    afterDrift,
    concurrency: 1 + intBelow(rng, 3),
    failures,
  }
}

describe('Feature: embedding-support, Property 1: Snapshot cấu hình bất biến trong một Logical_Call', () => {
  it(`holds for ${RUNS} generated calls with configuration drift mid-flight`, async () => {
    let sawMultiBatch = false
    let sawRetry = false
    let sawMidFlightDrift = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x01_0000 + run
      const rng = rngOf(seed)
      const generated = generateCase(rng, seed)
      const context = { seed }

      const adapter = new SnapshotAdapter(generated.initial, generated.failures)
      adapter.onCaptured = () => {
        adapter.config = generated.afterCapture
      }
      adapter.onDispatch = (ordinal) => {
        if (ordinal === generated.driftAtDispatch) adapter.config = generated.afterDrift
      }

      const options: EmbeddingHandleOptions = {
        provider: 'fake',
        model: 'embed-snapshot',
        dimensions: generated.dimensions,
        concurrency: generated.concurrency,
      }
      const result = await createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter,
        options,
        retryPolicy: RETRY_POLICY,
      }).embedMany({ values: generated.values, purpose: generated.purpose })

      // 1. Exactly ONE snapshot for the whole logical call, and it is frozen, so
      //    nothing downstream can edit the generation it dispatches through.
      expect({ ...context, generations: adapter.generations.length })
        .toEqual({ ...context, generations: 1 })
      const snapshot = adapter.generations[0] as PreparedEmbeddingCall
      expect({ ...context, frozen: Object.isFrozen(snapshot) })
        .toEqual({ ...context, frozen: true })

      // 2. Every dispatch — first attempt or retry — went through THAT generation.
      expect({
        ...context,
        generations: [...new Set(adapter.dispatches.map(record => record.generation))],
      }).toEqual({ ...context, generations: [1] })

      // 3. Batch shape follows the snapshot's `maxBatchItems`, not the wider bound
      //    the configuration moved to. Retries repeat a batch, so compare the
      //    DISTINCT batches by their first item index, in plan order.
      const firstAttempts = new Map<number, readonly number[]>()
      for (const record of adapter.dispatches) {
        const key = record.itemIndexes[0] as number
        if (!firstAttempts.has(key)) firstAttempts.set(key, record.itemIndexes)
      }
      const planned = [...firstAttempts.keys()].sort((left, right) => left - right)
      expect({ ...context, sizes: planned.map(key => firstAttempts.get(key)!.length) })
        .toEqual({
          ...context,
          sizes: [...expectedBatchSizes(
            generated.values.length,
            generated.initial.maxBatchItems as number,
          )],
        })
      // Every input carried exactly once, in input order across the plan.
      expect({ ...context, indexes: planned.flatMap(key => [...firstAttempts.get(key)!]) })
        .toEqual({ ...context, indexes: generated.values.map((_value, index) => index) })

      // 4. The published space is the snapshot's, and it is derivable from the
      //    published profile — the two cannot describe different generations.
      expect({ ...context, space: result.space })
        .toEqual({ ...context, space: snapshot.spaceId })
      expect({ ...context, profile: result.profile })
        .toEqual({ ...context, profile: snapshot.profile })
      expect({ ...context, derived: deriveSpaceId(result.profile) })
        .toEqual({ ...context, derived: result.space })

      // 5. Non-vacuity of 4: a snapshot taken NOW derives a different space and a
      //    different width, so the drift really was observable.
      const after = await adapter.prepareEmbeddingCall('fake', 'embed-snapshot', {})
      expect({ ...context, drifted: after.spaceId === snapshot.spaceId })
        .toEqual({ ...context, drifted: false })
      expect({ ...context, wider: after.limits.maxItems > snapshot.limits.maxItems })
        .toEqual({ ...context, wider: true })

      if (planned.length > 1) sawMultiBatch = true
      if (adapter.dispatches.length > planned.length) sawRetry = true
      if (adapter.dispatches.length >= generated.driftAtDispatch) sawMidFlightDrift = true
    }

    // Each of these is a scenario the generator must actually have produced for
    // the assertions above to carry weight.
    expect({ sawMultiBatch, sawRetry, sawMidFlightDrift })
      .toEqual({ sawMultiBatch: true, sawRetry: true, sawMidFlightDrift: true })
  })

  it('accepts a width the snapshot declared even after the route stops declaring it', async () => {
    const adapter = new SnapshotAdapter({
      dimensions: [4],
      defaultDimensions: 4,
      compatibilityIdentity: 'space-stable',
    })
    adapter.onCaptured = () => {
      // A live read here would reject the call with DIMENSIONS_UNSUPPORTED.
      adapter.config = { dimensions: [16], defaultDimensions: 16, compatibilityIdentity: 'space-stable' }
    }

    const result = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-snapshot', dimensions: 4 },
    }).embed({ value: 'alpha', purpose: 'retrieval-query' })

    expect(result.embedding).toHaveLength(4)
    expect(adapter.generations).toHaveLength(1)
  })

  it('rejects a width the snapshot forbids even after the route starts declaring it', async () => {
    const adapter = new SnapshotAdapter({
      dimensions: [16],
      defaultDimensions: 16,
      compatibilityIdentity: 'space-stable',
    })
    adapter.onCaptured = () => {
      // A live read here would ACCEPT the call, which is the mirror image of the
      // test above and the reason both are needed.
      adapter.config = { dimensions: [4], defaultDimensions: 4, compatibilityIdentity: 'space-stable' }
    }

    const failure = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-snapshot', dimensions: 4 },
    }).embed({ value: 'alpha', purpose: 'retrieval-query' }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EmbeddingError)
    expect((failure as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.DIMENSIONS_UNSUPPORTED)
    // Rejected against the snapshot, with nothing spent at the provider.
    expect(adapter.attempts).toHaveLength(0)
    expect(adapter.dispatches).toHaveLength(0)
  })

  it('measures input length against the snapshot ceiling, with zero attempts spent', async () => {
    // 4 estimated tokens: `'short'` measures 2 and passes, the long input
    // measures 100 and does not, so the report must name exactly one item.
    const adapter = new SnapshotAdapter({
      maxInputTokens: 4,
      defaultDimensions: 4,
      compatibilityIdentity: 'space-stable',
    })
    adapter.onCaptured = () => {
      adapter.config = {
        maxInputTokens: 100_000,
        defaultDimensions: 4,
        compatibilityIdentity: 'space-stable',
      }
    }

    const failure = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-snapshot' },
    }).embedMany({ values: ['short', 'x'.repeat(400)], purpose: 'retrieval-document' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(EmbeddingError)
    expect((failure as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE)
    // The ceiling that was applied is the snapshot's, and the report names the
    // offending input rather than the whole call.
    expect((failure as EmbeddingError).limit).toBe(4)
    expect((failure as EmbeddingError).itemIndexes).toEqual([1])
    expect(adapter.attempts).toHaveLength(0)
  })

  it('honours an expectedSpace that matches the snapshot, not the drifted route', async () => {
    const adapter = new SnapshotAdapter({
      defaultDimensions: 3,
      compatibilityIdentity: 'space-original',
    })
    const first = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-snapshot' },
    }).embed({ value: 'probe', purpose: 'retrieval-query' })

    // Same route, but its declared identity moves the moment the second call
    // snapshots it. The caller's expectation is about the snapshot.
    adapter.onCaptured = () => {
      adapter.config = { defaultDimensions: 3, compatibilityIdentity: 'space-drifted' }
    }
    const second = await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-snapshot' },
    }).embed({ value: 'probe', purpose: 'retrieval-query', expectedSpace: first.space })

    expect(second.space).toBe(first.space)
    expect(second.profile.compatibilityIdentity).toBe('space-original')

    // And the drifted route really would have produced another space.
    const drifted = await adapter.prepareEmbeddingCall('fake', 'embed-snapshot', {})
    expect(drifted.spaceId).not.toBe(first.space)
  })

  it('keys the cache from the snapshot, so a drifted route still hits', async () => {
    const { store, hits } = storeOf()
    const options: EmbeddingHandleOptions = {
      provider: 'fake',
      model: 'embed-snapshot',
      cache: { store, scope: 'tenant-a' },
    }
    const values = ['one', 'two', 'three']

    const warm = new SnapshotAdapter({ defaultDimensions: 4, compatibilityIdentity: 'space-warm' })
    await createEmbeddingModelHandle({ operations: schedulerOf(), adapter: warm, options })
      .embedMany({ values, purpose: 'retrieval-document' })
    const hitsAfterWarm = hits.count

    const adapter = new SnapshotAdapter({
      defaultDimensions: 4,
      compatibilityIdentity: 'space-warm',
    })
    adapter.onCaptured = () => {
      // A cache key or space gate read live would miss every entry here.
      adapter.config = { defaultDimensions: 4, compatibilityIdentity: 'space-cold' }
    }
    const result = await createEmbeddingModelHandle({ operations: schedulerOf(), adapter, options })
      .embedMany({ values, purpose: 'retrieval-document' })

    expect(hits.count - hitsAfterWarm).toBe(values.length)
    expect(result.usage.inputsFromCache).toBe(values.length)
    expect(adapter.attempts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Property 32
// ---------------------------------------------------------------------------

const TRANSPORT_HEADERS = Object.freeze({ 'content-type': 'application/json' })

/**
 * An adapter that snapshots an HTTP connection the way an embedding-over-HTTP
 * pipeline does: once, in `prepareEmbeddingCall()`, using the REAL
 * `captureTransportConnection`.
 *
 * The credential rotates on every dispatch, so a snapshot taken per batch would
 * hand out a header set no other batch saw — which is exactly the failure mode
 * Requirement 13.1 exists to rule out.
 */
class ConnectionSnapshotAdapter extends FakeEmbeddingAdapter {
  /** One entry per capture; Property 32 asserts one per operation. */
  readonly captures: HttpTransportConnection[] = []
  /** The connection each dispatch actually used. */
  readonly used: HttpTransportConnection[] = []
  /** Live route configuration, rotated between batches. */
  private connection: HttpTransportConnection
  private rotations = 0

  constructor(connection: HttpTransportConnection, dimensions = 4) {
    super({ dimensions })
    this.connection = connection
  }

  /** What a fresh capture would produce right now. */
  get live(): HttpTransportConnection {
    return this.connection
  }

  override async prepareEmbeddingCall(
    provider: string,
    model: string,
    options: PrepareEmbeddingOptions,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedEmbeddingCall> {
    const base = await super.prepareEmbeddingCall(provider, model, options, signal, context)
    // ONE capture per prepared call: endpoint, credential and bounds read together.
    const captured = captureTransportConnection(this.connection, TRANSPORT_HEADERS)
    this.captures.push(captured)
    return Object.freeze({
      ...base,
      embedBatch: (batch: EmbeddingBatchRequest, invocation?: ModelInvocationContext) => {
        this.used.push(captured)
        this.rotate()
        return base.embedBatch(batch, invocation)
      },
    })
  }

  /** Rotates the credential, so the live configuration leaves the snapshot behind. */
  private rotate(): void {
    this.rotations += 1
    this.connection = {
      ...this.connection,
      headers: { authorization: `Bearer rotated-${this.rotations}` },
    }
  }
}

describe('Feature: embedding-support, Property 32: Connection snapshot đúng một lần cho mỗi operation', () => {
  it(`captures once per logical call across ${RUNS} generated fan-outs`, async () => {
    let sawMultiBatch = false
    let sawRetry = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x20_0000 + run
      const rng = rngOf(seed)
      const context = { seed }
      const itemCount = 1 + intBelow(rng, 12)
      const maxItems = 1 + intBelow(rng, 4)
      const values = Array.from(
        { length: itemCount },
        (_value, index) => `connection-${seed}/item-${index}`,
      )

      const adapter = new ConnectionSnapshotAdapter({
        baseUrl: 'https://api.example.test',
        headers: { authorization: 'Bearer initial-token' },
        retryPolicy: RETRY_POLICY,
      })
      // A few batches fail once, so the fan-out includes retries: a retry is a
      // second physical request through the SAME operation, and must not re-capture.
      const failing = new Set<number>()
      for (let index = 0; index < itemCount; index += maxItems) {
        if (rng() < 0.3) failing.add(index)
      }
      const attemptsPerBatch = new Map<number, number>()
      const inner = adapter.embedBatch.bind(adapter)
      adapter.embedBatch = async (batch, invocation) => {
        const key = batch.items[0]?.index ?? -1
        const attempt = (attemptsPerBatch.get(key) ?? 0) + 1
        attemptsPerBatch.set(key, attempt)
        if (attempt === 1 && failing.has(key)) {
          throw new ModelError('scripted transient failure', MODEL_ERROR_CODES.SERVER)
        }
        return inner(batch, invocation)
      }

      await createEmbeddingModelHandle({
        operations: schedulerOf(),
        adapter,
        options: {
          provider: 'fake',
          model: 'embed-connection',
          batchLimits: { maxItems },
          concurrency: 1 + intBelow(rng, 3),
        },
        retryPolicy: RETRY_POLICY,
      }).embedMany({ values, purpose: 'retrieval-document' })

      const batchCount = expectedBatchSizes(itemCount, maxItems).length

      // The property: however many physical batches the call fanned out into, the
      // connection was captured exactly once.
      expect({ ...context, captures: adapter.captures.length })
        .toEqual({ ...context, captures: 1 })
      expect({ ...context, dispatches: adapter.used.length >= batchCount })
        .toEqual({ ...context, dispatches: true })
      // And every dispatch used THAT capture, not a later one.
      expect({ ...context, distinct: new Set(adapter.used).size })
        .toEqual({ ...context, distinct: 1 })

      // Non-vacuity: the live configuration moved, so a per-batch capture would
      // have produced a different credential for some batch.
      const captured = adapter.captures[0] as HttpTransportConnection
      expect({ ...context, drifted: adapter.live.headers.authorization === captured.headers.authorization })
        .toEqual({ ...context, drifted: false })

      if (batchCount > 1) sawMultiBatch = true
      if (adapter.used.length > batchCount) sawRetry = true
    }

    expect({ sawMultiBatch, sawRetry }).toEqual({ sawMultiBatch: true, sawRetry: true })
  })

  it('captures once per operation, so two logical calls capture twice', async () => {
    const adapter = new ConnectionSnapshotAdapter({
      baseUrl: 'https://api.example.test',
      headers: { authorization: 'Bearer initial-token' },
      retryPolicy: RETRY_POLICY,
    })
    const handle = createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-connection', batchLimits: { maxItems: 2 } },
    })

    await handle.embedMany({ values: ['a', 'b', 'c', 'd'], purpose: 'retrieval-query' })
    expect(adapter.captures).toHaveLength(1)

    await handle.embedMany({ values: ['e', 'f'], purpose: 'retrieval-query' })
    // One handle, two operations, two captures — and the second picked up the
    // rotated credential, which is what makes "per operation" the right grain.
    expect(adapter.captures).toHaveLength(2)
    expect(adapter.captures[1]!.headers.authorization)
      .not.toBe(adapter.captures[0]!.headers.authorization)
  })

  it('merges the transport layer beneath the credential exactly once', async () => {
    const adapter = new ConnectionSnapshotAdapter({
      baseUrl: 'https://api.example.test',
      headers: { authorization: 'Bearer initial-token' },
      sensitiveHeaderNames: ['authorization'],
      retryPolicy: RETRY_POLICY,
    })
    await createEmbeddingModelHandle({
      operations: schedulerOf(),
      adapter,
      options: { provider: 'fake', model: 'embed-connection' },
    }).embed({ value: 'alpha', purpose: 'retrieval-document' })

    const captured = adapter.captures[0] as HttpTransportConnection
    expect(captured.headers.authorization).toBe('Bearer initial-token')
    expect(captured.headers['content-type']).toBe('application/json')
    expect([...captured.sensitiveHeaderNames ?? []]).toContain('authorization')
    expect(Object.isFrozen(captured)).toBe(true)
  })
})
