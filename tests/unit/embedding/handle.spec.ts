/**
 * Property tests for `Embedding_Model_Handle` — the runtime surface a caller
 * actually touches: `runtime.embeddingModel()`, `embed()` and `embedMany()`.
 *
 * Five claims live here, and each one is asserted against something the SDK did
 * NOT compute itself:
 *
 * - **Property 3** — resolution is a fact about the embedding topology alone. The
 *   expected answer is recomputed from the generated topology, and a route that
 *   carries a GENERATION adapter is still a route without an embedding adapter.
 *   That case is the one a two-map registry would get wrong, so the generator is
 *   checked afterwards for having produced it.
 * - **Property 4** — every successful result carries vectors, a usage report and
 *   a `Space_Id`. The vectors are compared against `deterministicVector()`
 *   recomputed from the input text, and the space against `deriveSpaceId()` of a
 *   profile built independently from the catalog descriptor the fake route
 *   declares — never against `deriveSpaceId(result.profile)` alone, which would
 *   only prove the result is self-consistent.
 * - **Property 15** — an expected space is a rejection IF AND ONLY IF it is
 *   incompatible. Both directions matter, so the generator mutates
 *   space-deciding components (compatibility identity, dimensions,
 *   normalization, post-processing, profile revision) AND non-space-deciding
 *   ones (model identity, recipe revisions). The latter must still be accepted;
 *   an implementation comparing whole profiles would fail exactly there.
 * - **Property 16** — a fallback is a declaration checked at configuration time,
 *   never a dispatch. A second adapter is registered on the same route for the
 *   declared fallback model, and the assertion is that it records ZERO attempts
 *   whatever the primary did.
 * - **Property 31** — once close has begun, no new handle is handed out. Driven
 *   at four different moments, including with a `Logical_Call` in flight, and
 *   with a real `RuntimeOperations` rather than a stub, because the state machine
 *   under test is that object's.
 *
 * ## What is driven, and why
 *
 * The generated bulk runs through `RuntimeEmbedding` with a real
 * `RuntimeOperations` and a real `EmbeddingRegistry` — the same objects
 * `RuntimeCompositionOwner.embeddingModel()` delegates to, and the two whose
 * behaviour is under test. Faking either would test the fake. The scenario tests
 * at the end stand up a REAL runtime through `createRuntimeCompositionOwner()`,
 * because "starts, serves embedding and closes with only one plugin kind
 * present" (Requirements 11.8, 11.9) is a claim about a whole runtime and cannot
 * be supported by a unit assertion on a helper.
 *
 * ## Placement (deviation from the task-named path)
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/handle.spec.ts`. No runner
 * collects that directory: the root `vitest.config.ts` includes `tests/**`. This
 * file therefore sits beside `tests/unit/embedding/{manager,order,planner}.spec.ts`,
 * which document the same deviation, and imports package sources by relative
 * path so it typechecks against the code under change rather than a built `dist/`.
 *
 * ## Seeded generation
 *
 * The repository carries no property-testing dependency; the convention in the
 * sibling embedding specs is a seeded mulberry32 generator, so a failure
 * reproduces from the printed seed and nothing test-only enters the dependency
 * graph. `RUNS` is above the spec floor of 100.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 6.2, 6.5, 6.6, 6.7, 11.8, 11.9, 12.6**
 *
 * @module tests/unit/embedding/handle.spec
 */

import { describe, expect, it } from 'vitest'
import { defineEmbeddingProviderPlugin } from '../../../packages/core/src/composition/embedding/definition.ts'
import type { EmbeddingHandleOptions } from '../../../packages/core/src/composition/embedding/handle.ts'
import { RuntimeEmbedding } from '../../../packages/core/src/composition/embedding/manager.ts'
import { EmbeddingRegistry } from '../../../packages/core/src/composition/embedding/registry.ts'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { RuntimeOwnerOptions } from '../../../packages/core/src/composition/runtime/types.ts'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheStore,
  EmbeddingModelHandle,
} from '../../../packages/core/src/embedding/handle.ts'
import type {
  EmbeddingNormalization,
  EmbeddingProfile,
  EmbeddingSpaceId,
} from '../../../packages/core/src/embedding/profile.ts'
import {
  defaultEmbeddingProfile,
  deriveSpaceId,
} from '../../../packages/core/src/embedding/profile.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import type { EmbeddingUsageReport } from '../../../packages/core/src/embedding/usage.ts'
import { AgentSdkError } from '../../../packages/core/src/errors/agent-sdk-error.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../../packages/core/src/errors/model-error.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import {
  deterministicVector,
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
// Shared fixture: the exact objects `RuntimeCompositionOwner` delegates to
// ---------------------------------------------------------------------------

/** A generation adapter that finishes immediately; only its presence matters here. */
class Generation extends ModelAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface ManagerFixture {
  readonly manager: RuntimeEmbedding
  readonly operations: RuntimeOperations
  readonly registry: EmbeddingRegistry
  /** Generation topology, so "route exists for generation" is a real condition. */
  readonly models: ModelRegistry
}

function managerFixture(): ManagerFixture {
  const resources = new RuntimeResources(createRuntimePlatform(globalThis))
  const operations = new RuntimeOperations(resources)
  const registry = new EmbeddingRegistry()
  // No handle caching: every generated case must resolve against the topology it
  // built rather than against a handle a previous case left behind.
  const manager = new RuntimeEmbedding({ registry, operations, options: { maxCachedHandles: 0 } })
  return { manager, operations, registry, models: new ModelRegistry() }
}

it('rejects malformed content parts and sparse inputs with a structured request error', async () => {
  const fixture = managerFixture()
  fixture.registry.registerEmbeddingAdapter(['embedding'], new FakeEmbeddingAdapter())
  const handle = fixture.manager.model({ provider: 'embedding', model: SHARED_MODEL })
  for (const parts of [[null], [{ type: 'text', text: 42 }], [{ type: 'image', text: 'ignored' }], new Array(1)]) {
    await expect(handle.embedMany({ values: [parts] as never, purpose: 'retrieval-document' })).rejects.toMatchObject({
      code: EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    })
  }
  await expect(handle.embedMany({ values: new Array(1), purpose: 'retrieval-document' }))
    .rejects.toMatchObject({ code: EMBEDDING_ERROR_CODES.REQUEST_INVALID })
})

/** An in-memory cache store, and a count of the reads that hit. */
function storeOf(): { readonly store: EmbeddingCacheStore; readonly hits: { count: number } } {
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

/** The thrown value, or `undefined` when the call unexpectedly succeeded. */
function caught(work: () => unknown): unknown {
  try {
    work()
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * The handle, or the error that prevented it.
 *
 * A separate helper from {@link caught} because a handle is a legitimate result
 * here: collapsing "no error" and "no value" into one `undefined` is what turned
 * a construction success into a null dereference the first time this was written.
 */
function built<T>(work: () => T):
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown } {
  try {
    return { ok: true, value: work() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** The stable code of a thrown value, or `undefined` when it carries none. */
function codeOf(error: unknown): string | undefined {
  return error instanceof AgentSdkError ? error.code : undefined
}

// ---------------------------------------------------------------------------
// Property 3: a route with no embedding adapter is rejected by a stable code
// ---------------------------------------------------------------------------

/** How one generated route is claimed, per operation. */
interface RouteSpec {
  readonly route: string
  /** A generation adapter claims this route. Irrelevant to embedding resolution. */
  readonly generation: boolean
  readonly embedding: 'none' | 'wide' | 'models'
  /** Model ids a model-scoped embedding registration claims. */
  readonly models: readonly string[]
}

/** A model id every route is asked about, claimed by some routes and not others. */
const SHARED_MODEL = 'text-embedding-3-small'

function generateTopology(rng: Rng, seed: number): readonly RouteSpec[] {
  const count = 1 + intBelow(rng, 4)
  return Array.from({ length: count }, (_value, index) => {
    const route = `route-${seed}-${index}`
    const embedding = pick(rng, ['none', 'wide', 'models'] as const)
    const models = embedding !== 'models'
      ? []
      : [
        ...(rng() < 0.6 ? [SHARED_MODEL] : []),
        `${route}-own-model`,
      ]
    return { route, generation: rng() < 0.6, embedding, models }
  })
}

describe('Feature: embedding-support, Property 3: Route không có adapter bị từ chối bằng code ổn định', () => {
  it(`holds for ${RUNS} generated topologies, generation-only routes included`, () => {
    let sawGenerationOnlyRejection = false
    let sawModelScopedMiss = false
    let sawModelScopedHit = false
    let sawRouteWideHit = false
    let sawUnknownRoute = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x03_0000 + run
      const rng = rngOf(seed)
      const specs = generateTopology(rng, seed)
      const fixture = managerFixture()

      for (const spec of specs) {
        if (spec.generation) fixture.models.registerAdapter([spec.route], new Generation())
        if (spec.embedding === 'wide') {
          fixture.registry.registerEmbeddingAdapter([spec.route], new FakeEmbeddingAdapter())
        }
        if (spec.embedding === 'models') {
          fixture.registry.registerEmbeddingAdapter(
            [spec.route], new FakeEmbeddingAdapter(), spec.models,
          )
        }
      }

      // Every route is asked about the ids it claims, an id it never claims, and
      // the shared id — so a model-scoped registration is probed on both sides.
      for (const spec of specs) {
        const queries = [...spec.models, SHARED_MODEL, `${spec.route}-absent-model`]
        for (const model of queries) {
          const context = { seed, route: spec.route, model, embedding: spec.embedding }
          // Recomputed from the generated topology, never read back from it.
          const claimed = spec.embedding === 'wide'
            || (spec.embedding === 'models' && spec.models.includes(model))
          const error = caught(() => fixture.manager.model({ provider: spec.route, model }))

          if (claimed) {
            expect({ ...context, code: codeOf(error) }).toEqual({ ...context, code: undefined })
            if (spec.embedding === 'wide') sawRouteWideHit = true
            else sawModelScopedHit = true
            continue
          }
          expect({ ...context, instance: error instanceof EmbeddingError, code: codeOf(error) })
            .toEqual({
              ...context,
              instance: true,
              code: EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
            })
          // The generation adapter is live on this route at this very moment: a
          // registry that answered per route rather than per route+operation
          // would have handed back a `ModelAdapter` here.
          if (spec.generation && spec.embedding === 'none') {
            expect(fixture.models.listProviders().map(row => row.id)).toContain(spec.route)
            sawGenerationOnlyRejection = true
          }
          if (spec.embedding === 'models') sawModelScopedMiss = true
        }
      }

      // A route nothing ever declared answers with the same code, not a different one.
      const ghost = caught(() => fixture.manager.model({ provider: `ghost-${seed}`, model: SHARED_MODEL }))
      expect({ seed, code: codeOf(ghost) })
        .toEqual({ seed, code: EMBEDDING_ERROR_CODES.ADAPTER_MISSING })
      sawUnknownRoute = true
    }

    // Each flag is a wrong implementation the generator must actually have reached.
    expect({
      sawGenerationOnlyRejection,
      sawModelScopedMiss,
      sawModelScopedHit,
      sawRouteWideHit,
      sawUnknownRoute,
    }).toEqual({
      sawGenerationOnlyRejection: true,
      sawModelScopedMiss: true,
      sawModelScopedHit: true,
      sawRouteWideHit: true,
      sawUnknownRoute: true,
    })
  })

  it('keeps the missing-adapter failure at the `embeddingModel()` call, before any dispatch', () => {
    const fixture = managerFixture()
    const adapter = new FakeEmbeddingAdapter()
    fixture.registry.registerEmbeddingAdapter(['claimed'], adapter, ['only-this-model'])

    const error = caught(() => fixture.manager.model({ provider: 'claimed', model: 'other-model' }))
    expect(error).toBeInstanceOf(EmbeddingError)
    expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.ADAPTER_MISSING)
    // Resolution happens synchronously in `embeddingModel()`, so nothing was sent.
    expect(adapter.attempts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Property 4: every result carries vectors, usage and a Space_Id
// ---------------------------------------------------------------------------

const PURPOSES: readonly EmbeddingPurpose[] = Object.freeze([
  'retrieval-query',
  'retrieval-document',
])

/** Multi-byte texts, mixed with plain ASCII: byte length ≠ code-unit length. */
const UNICODE_SAMPLES: readonly string[] = Object.freeze([
  'xin chào thế giới',
  'Đà Nẵng · Hà Nội',
  '埋め込みベクトル',
  'вектор вложения',
  '🙈🙉🙊 emoji run',
  'e\u0301galite\u0301 combining',
])

const ROUTE = 'fake-embed'
const MODEL = 'embed-handle'

/**
 * The space the route WOULD produce vectors in, derived from the catalog
 * descriptor the fake adapter declares rather than from the result under test.
 */
function expectedSpaceFor(dimensions: number | undefined): EmbeddingSpaceId {
  return deriveSpaceId(defaultEmbeddingProfile(
    fakeEmbeddingModel(ROUTE, MODEL),
    dimensions === undefined ? {} : { dimensions },
  ))
}

/** One generated `Logical_Call` for Property 4. */
interface ResultCase {
  readonly values: readonly string[]
  readonly purpose: EmbeddingPurpose
  /** Absent means the fake's own default width, which is what most callers do. */
  readonly dimensions: number | undefined
  readonly single: boolean
  /** Warm the whole call first, so the call under test is 100 % cache hits. */
  readonly fullyCached: boolean
  readonly maxItems: number
}

/** The fake adapter's vector width for a call that named `dimensions` or did not. */
const FAKE_DEFAULT_DIMENSIONS = 4

function generateResultCase(rng: Rng, seed: number): ResultCase {
  const single = rng() < 0.25
  const count = single ? 1 : 1 + intBelow(rng, 7)
  const values = Array.from({ length: count }, (_value, index) =>
    rng() < 0.5
      ? `${pick(rng, UNICODE_SAMPLES)} #${seed}-${index}`
      : `plain-${seed}-${index}`)
  return {
    values,
    purpose: pick(rng, PURPOSES),
    dimensions: rng() < 0.5 ? undefined : 2 + intBelow(rng, 5),
    single,
    fullyCached: rng() < 0.3,
    maxItems: 1 + intBelow(rng, 3),
  }
}

/** Assertable facts of one settled `Logical_Call`, whichever method produced it. */
interface ResultObservation {
  readonly vectors: readonly (readonly number[])[]
  readonly space: EmbeddingSpaceId
  readonly profile: EmbeddingProfile
  readonly usage: EmbeddingUsageReport
  readonly attempts: number
}

async function runResultCase(generated: ResultCase): Promise<ResultObservation> {
  const fixture = managerFixture()
  const adapter = new FakeEmbeddingAdapter({ dimensions: FAKE_DEFAULT_DIMENSIONS })
  fixture.registry.registerEmbeddingAdapter([ROUTE], adapter)
  const { store } = storeOf()
  const handle = fixture.manager.model({
    provider: ROUTE,
    model: MODEL,
    ...(generated.dimensions === undefined ? {} : { dimensions: generated.dimensions }),
    batchLimits: { maxItems: generated.maxItems },
    ...(generated.fullyCached ? { cache: { store, scope: 'tenant-a' } } : {}),
  })

  if (generated.fullyCached) {
    // Same handle, same store: the second call reads back exactly what this wrote.
    await handle.embedMany({ values: generated.values, purpose: generated.purpose })
  }
  const attemptsBefore = adapter.attempts.length

  if (generated.single) {
    const result = await handle.embed({
      value: generated.values[0] as string,
      purpose: generated.purpose,
    })
    return {
      vectors: [result.embedding],
      space: result.space,
      profile: result.profile,
      usage: result.usage,
      attempts: adapter.attempts.length - attemptsBefore,
    }
  }
  const result = await handle.embedMany({
    values: generated.values,
    purpose: generated.purpose,
  })
  return {
    vectors: result.embeddings,
    space: result.space,
    profile: result.profile,
    usage: result.usage,
    attempts: adapter.attempts.length - attemptsBefore,
  }
}

describe('Feature: embedding-support, Property 4: Mọi kết quả mang vector, usage và Space_Id', () => {
  it(`holds for ${RUNS} generated calls, including single inputs, unicode and full cache hits`, async () => {
    let sawSingle = false
    let sawFullyCached = false
    let sawMultiBatch = false
    let sawDeclaredDimensions = false
    let sawUnicode = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x04_0000 + run
      const rng = rngOf(seed)
      const generated = generateResultCase(rng, seed)
      const observed = await runResultCase(generated)
      const context = { seed }
      const width = generated.dimensions ?? FAKE_DEFAULT_DIMENSIONS
      const inputs = generated.single ? 1 : generated.values.length

      // 1. A vector per input, each of the expected width, each element finite —
      //    and equal to what the provider produced for that exact text, recomputed
      //    here rather than read back from the result.
      expect({ ...context, count: observed.vectors.length }).toEqual({ ...context, count: inputs })
      for (const [index, vector] of observed.vectors.entries()) {
        const value = generated.values[index] as string
        expect({ ...context, index, vector: [...vector] }).toEqual({
          ...context,
          index,
          vector: [...deterministicVector(value, width)],
        })
        expect({ ...context, index, finite: vector.every(Number.isFinite) })
          .toEqual({ ...context, index, finite: true })
      }

      // 2. A usage report is always present, and every input is accounted for
      //    exactly once by one of the two disjoint sources.
      const usage = observed.usage
      expect({ ...context, status: ['complete', 'partial', 'missing'].includes(usage.status) })
        .toEqual({ ...context, status: true })
      expect({ ...context, total: usage.inputsFromCache + usage.inputsFromProvider })
        .toEqual({ ...context, total: inputs })
      expect({ ...context, attempts: usage.providerAttempts })
        .toEqual({ ...context, attempts: observed.attempts })

      // 3. The space is the one the route's profile derives, and the profile that
      //    travels with the result derives that same space.
      expect({ ...context, space: observed.space })
        .toEqual({ ...context, space: expectedSpaceFor(generated.dimensions) })
      expect({ ...context, space: deriveSpaceId(observed.profile) })
        .toEqual({ ...context, space: observed.space })

      if (generated.fullyCached) {
        // Nothing reached the provider, and the result is still complete.
        expect({ ...context, cached: usage.inputsFromCache, attempts: observed.attempts })
          .toEqual({ ...context, cached: inputs, attempts: 0 })
        sawFullyCached = true
      }
      if (generated.single) sawSingle = true
      if (observed.attempts > 1) sawMultiBatch = true
      if (generated.dimensions !== undefined) sawDeclaredDimensions = true
      if (generated.values.some(value => UNICODE_SAMPLES.some(sample => value.startsWith(sample)))) {
        sawUnicode = true
      }
    }

    expect({ sawSingle, sawFullyCached, sawMultiBatch, sawDeclaredDimensions, sawUnicode })
      .toEqual({
        sawSingle: true,
        sawFullyCached: true,
        sawMultiBatch: true,
        sawDeclaredDimensions: true,
        sawUnicode: true,
      })
  })

  it('reports the space a route declares, not one derived from the model name', async () => {
    const fixture = managerFixture()
    // Two model ids, ONE declared compatibility identity: same space, and the
    // model name plays no part in it.
    const adapter = new FakeEmbeddingAdapter({
      model: fakeEmbeddingModel(ROUTE, MODEL, {
        compatibilityIdentity: supported('vendor-space-v3'),
      }),
    })
    fixture.registry.registerEmbeddingAdapter([ROUTE], adapter)
    const first = await fixture.manager
      .model({ provider: ROUTE, model: 'model-a' })
      .embed({ value: 'tài liệu', purpose: 'retrieval-document' })
    const second = await fixture.manager
      .model({ provider: ROUTE, model: 'model-b' })
      .embed({ value: 'câu truy vấn', purpose: 'retrieval-query' })

    expect(first.space).toBe(second.space)
    expect(first.profile.compatibilityIdentity).toBe('vendor-space-v3')
  })

  it('gives a query and a document of one profile the same Space_Id', async () => {
    const fixture = managerFixture()
    fixture.registry.registerEmbeddingAdapter([ROUTE], new FakeEmbeddingAdapter())
    const handle = fixture.manager.model({ provider: ROUTE, model: MODEL })
    const query = await handle.embed({ value: 'truy vấn', purpose: 'retrieval-query' })
    const document = await handle.embed({ value: 'tài liệu', purpose: 'retrieval-document' })
    expect(query.space).toBe(document.space)
  })
})

// ---------------------------------------------------------------------------
// Property 15: an incompatible expected space rejects the call
// ---------------------------------------------------------------------------

const NORMALIZATIONS: readonly EmbeddingNormalization[] = Object.freeze([
  'unit-l2',
  'none',
  'unknown',
])

/** Which component of the expected profile the generator perturbs. */
type Mutation =
  | 'none'
  | 'compatibilityIdentity'
  | 'dimensions'
  | 'normalization'
  | 'postProcessing'
  | 'profileRevision'
  /** Recorded on the profile but NOT part of space identity (DD-7). */
  | 'modelIdentity'
  | 'recipeRevisions'

const MUTATIONS: readonly Mutation[] = Object.freeze([
  'none',
  'compatibilityIdentity',
  'dimensions',
  'normalization',
  'postProcessing',
  'profileRevision',
  'modelIdentity',
  'recipeRevisions',
])

/** The profile the generated route will actually declare. */
function generateProfile(rng: Rng, seed: number): EmbeddingProfile {
  const withPostProcessing = rng() < 0.5
  return {
    modelIdentity: `${ROUTE}:${MODEL}-${seed}`,
    dimensions: 2 + intBelow(rng, 6),
    representation: 'dense-float32',
    normalization: pick(rng, NORMALIZATIONS),
    ...(withPostProcessing
      ? { postProcessing: { kind: 'l2-renormalize' as const, revision: `r${intBelow(rng, 3)}` } }
      : {}),
    documentRecipeRevision: `doc-${intBelow(rng, 3)}`,
    queryRecipeRevision: `qry-${intBelow(rng, 3)}`,
    compatibilityIdentity: `space-${intBelow(rng, 4)}`,
    profileRevision: `p${intBelow(rng, 3)}`,
  }
}

/** The expected profile a caller holds: the real one, with one component perturbed. */
function mutateProfile(profile: EmbeddingProfile, mutation: Mutation): EmbeddingProfile {
  switch (mutation) {
    case 'none':
      return profile
    case 'compatibilityIdentity':
      return { ...profile, compatibilityIdentity: `${profile.compatibilityIdentity}-other` }
    case 'dimensions':
      return { ...profile, dimensions: profile.dimensions + 1 }
    case 'normalization':
      return {
        ...profile,
        normalization: NORMALIZATIONS.find(value => value !== profile.normalization) as EmbeddingNormalization,
      }
    case 'postProcessing': {
      if (profile.postProcessing === undefined) {
        return { ...profile, postProcessing: { kind: 'l2-renormalize', revision: 'added' } }
      }
      // Dropping the step is the same perturbation in the other direction, and the
      // key has to be ABSENT for it: a present `postProcessing: undefined` is a
      // third shape the profile type does not have, so it would test nothing.
      const { postProcessing: _dropped, ...withoutPostProcessing } = profile
      return withoutPostProcessing
    }
    case 'profileRevision':
      return { ...profile, profileRevision: `${profile.profileRevision}-next` }
    case 'modelIdentity':
      return { ...profile, modelIdentity: `${profile.modelIdentity}-renamed` }
    case 'recipeRevisions':
      return {
        ...profile,
        documentRecipeRevision: `${profile.documentRecipeRevision}-next`,
        queryRecipeRevision: `${profile.queryRecipeRevision}-next`,
      }
  }
}

describe('Feature: embedding-support, Property 15: Space_Id kỳ vọng không tương thích thì lời gọi bị từ chối', () => {
  it(`rejects if and only if the expected space is incompatible, over ${RUNS} generated profiles`, async () => {
    let sawAccepted = false
    let sawRejected = false
    let sawNonSpaceComponentAccepted = false
    let sawOptionLevelExpectation = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x0f_0000 + run
      const rng = rngOf(seed)
      const profile = generateProfile(rng, seed)
      const mutation = pick(rng, MUTATIONS)
      const expectedSpace = deriveSpaceId(mutateProfile(profile, mutation))
      // Derived from the two profiles, not from what the runtime decided.
      const compatible = expectedSpace === deriveSpaceId(profile)
      const perCall = rng() < 0.5
      const single = rng() < 0.5
      const context = { seed, mutation, compatible, perCall }

      const fixture = managerFixture()
      const adapter = new FakeEmbeddingAdapter({ profileFor: () => profile })
      fixture.registry.registerEmbeddingAdapter([ROUTE], adapter)
      const handle = fixture.manager.model({
        provider: ROUTE,
        model: MODEL,
        ...(perCall ? {} : { expectedSpace }),
      })
      const values = ['một', 'hai']
      const call = single
        ? handle.embed({
          value: values[0] as string,
          purpose: 'retrieval-query',
          ...(perCall ? { expectedSpace } : {}),
        })
        : handle.embedMany({
          values,
          purpose: 'retrieval-document',
          ...(perCall ? { expectedSpace } : {}),
        })

      const settled = await call.then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )

      expect({ ...context, ok: settled.ok }).toEqual({ ...context, ok: compatible })
      if (settled.ok) {
        expect({ ...context, space: settled.value.space })
          .toEqual({ ...context, space: deriveSpaceId(profile) })
        sawAccepted = true
        // A perturbation of a component that does NOT decide space identity must
        // land here; a whole-profile comparison would have rejected it.
        if (mutation === 'modelIdentity' || mutation === 'recipeRevisions') {
          sawNonSpaceComponentAccepted = true
        }
        if (!perCall) sawOptionLevelExpectation = true
        continue
      }
      expect({ ...context, code: codeOf(settled.error) })
        .toEqual({ ...context, code: EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE })
      // Pre-dispatch: the rejection costs nothing at the provider.
      expect({ ...context, attempts: adapter.attempts.length })
        .toEqual({ ...context, attempts: 0 })
      sawRejected = true
    }

    expect({ sawAccepted, sawRejected, sawNonSpaceComponentAccepted, sawOptionLevelExpectation })
      .toEqual({
        sawAccepted: true,
        sawRejected: true,
        sawNonSpaceComponentAccepted: true,
        sawOptionLevelExpectation: true,
      })
  })

  it('rejects an expected space that differs only in dimensions, same identity', async () => {
    const fixture = managerFixture()
    const profile = generateProfile(rngOf(1), 1)
    fixture.registry.registerEmbeddingAdapter([ROUTE], new FakeEmbeddingAdapter({
      profileFor: () => profile,
    }))
    const expectedSpace = deriveSpaceId({ ...profile, dimensions: profile.dimensions + 8 })
    await expect(fixture.manager
      .model({ provider: ROUTE, model: MODEL })
      .embed({ value: 'kiểm tra', purpose: 'retrieval-query', expectedSpace }))
      .rejects.toMatchObject({ code: EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE })
  })
})

// ---------------------------------------------------------------------------
// Property 16: no fallback outside the declared compatibility group
// ---------------------------------------------------------------------------

const PRIMARY_MODEL = 'primary-embed'
const FALLBACK_MODEL = 'fallback-embed'
const GROUP_IDENTITY = 'vendor-space-v3'

/** Failure codes the default retry policy does NOT retry, so a run costs no backoff. */
const TERMINAL_FAILURES: readonly (() => unknown)[] = Object.freeze([
  () => new EmbeddingError('provider rejected the batch', EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED),
  () => new ModelError('credentials rejected', MODEL_ERROR_CODES.AUTH),
  () => new ModelError('request refused', MODEL_ERROR_CODES.INVALID_REQUEST),
  () => new EmbeddingError('input too large', EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE, { limit: 8 }),
])

/** How the generated case declares its fallback group. */
type FallbackShape =
  /** No fallback declared at all. */
  | 'absent'
  /** Every member declares the identity the route resolves: a legitimate group. */
  | 'in-group'
  /** Members disagree with each other: not one group at all. */
  | 'mixed-identities'
  /** One consistent identity, but not the one the route resolves. */
  | 'foreign-identity'

const FALLBACK_SHAPES: readonly FallbackShape[] = Object.freeze([
  'absent', 'in-group', 'mixed-identities', 'foreign-identity',
])

interface FallbackFixture {
  readonly primary: FakeEmbeddingAdapter
  /** Registered for {@link FALLBACK_MODEL} on the SAME route, and never legitimate to call. */
  readonly secondary: FakeEmbeddingAdapter
  readonly manager: RuntimeEmbedding
}

function fallbackFixture(failing: boolean): FallbackFixture {
  const fixture = managerFixture()
  const declared = fakeEmbeddingModel(ROUTE, PRIMARY_MODEL, {
    compatibilityIdentity: supported(GROUP_IDENTITY),
  })
  const primary = new FakeEmbeddingAdapter({
    model: declared,
    ...(failing ? { errorFor: (attempt: number) => TERMINAL_FAILURES[attempt % TERMINAL_FAILURES.length]!() } : {}),
  })
  const secondary = new FakeEmbeddingAdapter({ model: declared })
  fixture.registry.registerEmbeddingAdapter([ROUTE], primary, [PRIMARY_MODEL])
  fixture.registry.registerEmbeddingAdapter([ROUTE], secondary, [FALLBACK_MODEL])
  return { primary, secondary, manager: fixture.manager }
}

function fallbackOptions(shape: FallbackShape): EmbeddingHandleOptions {
  const base: EmbeddingHandleOptions = { provider: ROUTE, model: PRIMARY_MODEL }
  switch (shape) {
    case 'absent':
      return base
    case 'in-group':
      return {
        ...base,
        compatibilityIdentity: GROUP_IDENTITY,
        fallback: [{ model: FALLBACK_MODEL, compatibilityIdentity: GROUP_IDENTITY }],
      }
    case 'mixed-identities':
      return {
        ...base,
        fallback: [
          { model: FALLBACK_MODEL, compatibilityIdentity: GROUP_IDENTITY },
          { model: 'third-embed', compatibilityIdentity: 'another-space' },
        ],
      }
    case 'foreign-identity':
      return {
        ...base,
        fallback: [{ model: FALLBACK_MODEL, compatibilityIdentity: 'another-space' }],
      }
  }
}

describe('Feature: embedding-support, Property 16: Không có fallback ra ngoài nhóm đã khai báo tương thích', () => {
  it(`propagates the primary failure and calls no other model, over ${RUNS} generated cases`, async () => {
    let sawPropagatedFailure = false
    let sawInGroupDeclaration = false
    let sawMixedRejectedAtConstruction = false
    let sawForeignRejectedBeforeDispatch = false
    let sawSuccessWithGroupDeclared = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x10_0000 + run
      const rng = rngOf(seed)
      const shape = pick(rng, FALLBACK_SHAPES)
      // The primary either fails terminally or succeeds; either way no second
      // model may be dispatched.
      const failing = rng() < 0.7
      const context = { seed, shape, failing }
      const fixture = fallbackFixture(failing)

      // A group that spans two identities is rejected when the handle is BUILT,
      // whether or not the primary would ever have failed.
      const construction = built(() => fixture.manager.model(fallbackOptions(shape)))
      if (shape === 'mixed-identities') {
        expect({ ...context, code: construction.ok ? undefined : codeOf(construction.error) })
          .toEqual({ ...context, code: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID })
        expect({ ...context, primary: fixture.primary.attempts.length, secondary: fixture.secondary.attempts.length })
          .toEqual({ ...context, primary: 0, secondary: 0 })
        sawMixedRejectedAtConstruction = true
        continue
      }
      expect({ ...context, code: construction.ok ? undefined : codeOf(construction.error) })
        .toEqual({ ...context, code: undefined })
      const handle = (construction as { readonly value: EmbeddingModelHandle }).value

      const settled = await handle
        .embedMany({ values: ['một', 'hai', 'ba'], purpose: 'retrieval-document' })
        .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))

      // THE invariant: whatever happened, the other model was never dispatched.
      expect({ ...context, secondary: fixture.secondary.attempts.length })
        .toEqual({ ...context, secondary: 0 })

      if (shape === 'foreign-identity') {
        // A declared identity the route does not resolve is a configuration
        // failure, raised before the first batch goes out.
        expect({ ...context, ok: settled.ok, code: settled.ok ? undefined : codeOf(settled.error) })
          .toEqual({ ...context, ok: false, code: EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID })
        expect({ ...context, primary: fixture.primary.attempts.length })
          .toEqual({ ...context, primary: 0 })
        sawForeignRejectedBeforeDispatch = true
        continue
      }

      if (failing) {
        // The primary's failure IS the call's failure: it is neither swallowed
        // nor replaced by a second model's result.
        expect({ ...context, ok: settled.ok }).toEqual({ ...context, ok: false })
        // Narrowed through the discriminant rather than asserted around it: a
        // success reaching here leaves `code` undefined, which the next
        // expectation reports as a failure instead of hiding behind a cast.
        const code = settled.ok ? undefined : codeOf(settled.error)
        expect({ ...context, known: code !== undefined && code.length > 0 })
          .toEqual({ ...context, known: true })
        expect({ ...context, dispatched: fixture.primary.attempts.length > 0 })
          .toEqual({ ...context, dispatched: true })
        sawPropagatedFailure = true
      } else {
        expect({ ...context, ok: settled.ok }).toEqual({ ...context, ok: true })
        if (shape === 'in-group') sawSuccessWithGroupDeclared = true
      }
      if (shape === 'in-group') sawInGroupDeclaration = true
    }

    expect({
      sawPropagatedFailure,
      sawInGroupDeclaration,
      sawMixedRejectedAtConstruction,
      sawForeignRejectedBeforeDispatch,
      sawSuccessWithGroupDeclared,
    }).toEqual({
      sawPropagatedFailure: true,
      sawInGroupDeclaration: true,
      sawMixedRejectedAtConstruction: true,
      sawForeignRejectedBeforeDispatch: true,
      sawSuccessWithGroupDeclared: true,
    })
  })

  it('rejects an empty fallback declaration rather than treating it as "no fallback"', () => {
    const fixture = fallbackFixture(false)
    const error = caught(() => fixture.manager.model({
      provider: ROUTE, model: PRIMARY_MODEL, fallback: [],
    }))
    expect(codeOf(error)).toBe(EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
  })

  it('rejects a fallback entry that names a model without declaring an identity', () => {
    const fixture = fallbackFixture(false)
    const error = caught(() => fixture.manager.model({
      provider: ROUTE,
      model: PRIMARY_MODEL,
      fallback: [{ model: FALLBACK_MODEL } as never],
    }))
    expect(codeOf(error)).toBe(EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
  })
})

// ---------------------------------------------------------------------------
// Property 31: a closing runtime hands out no new handle
// ---------------------------------------------------------------------------

/** When close begins, relative to the handles and calls of the generated case. */
type CloseMoment =
  | 'before-any-handle'
  | 'after-a-handle'
  | 'after-a-settled-call'
  | 'while-a-call-is-in-flight'
  | 'after-close-finished'

const CLOSE_MOMENTS: readonly CloseMoment[] = Object.freeze([
  'before-any-handle',
  'after-a-handle',
  'after-a-settled-call',
  'while-a-call-is-in-flight',
  'after-close-finished',
])

/** Codes that state "this runtime is no longer admitting work". */
const CLOSED_CODES: ReadonlySet<string> = new Set(['RUNTIME_CLOSING', 'RUNTIME_CLOSED'])

describe('Feature: embedding-support, Property 31: Runtime đang đóng từ chối handle mới', () => {
  it(`rejects \`embeddingModel()\` at ${RUNS} generated close moments`, async () => {
    const seen = new Set<CloseMoment>()

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1f_0000 + run
      const rng = rngOf(seed)
      const moment = pick(rng, CLOSE_MOMENTS)
      const context = { seed, moment }

      const fixture = managerFixture()
      const adapter = new FakeEmbeddingAdapter({
        // Long enough that the call is genuinely still in flight when close begins.
        ...(moment === 'while-a-call-is-in-flight' ? { delayMs: 25 } : {}),
      })
      fixture.registry.registerEmbeddingAdapter([ROUTE], adapter)

      if (moment === 'after-a-handle' || moment === 'after-a-settled-call'
        || moment === 'while-a-call-is-in-flight') {
        const handle = fixture.manager.model({ provider: ROUTE, model: MODEL })
        if (moment === 'after-a-settled-call') {
          await handle.embedMany({ values: ['một', 'hai'], purpose: 'retrieval-document' })
        }
        if (moment === 'while-a-call-is-in-flight') {
          // Abandoned on purpose: close aborts it, and its rejection is Property
          // 29/30's business, not this one's.
          void handle
            .embedMany({ values: ['một', 'hai'], purpose: 'retrieval-document' })
            .catch(() => undefined)
        }
      }

      const quiescence = fixture.operations.beginClose({ timeoutMs: 10 })
      if (moment === 'after-close-finished') {
        await quiescence
        fixture.operations.finishClose()
      } else {
        void quiescence.catch(() => undefined)
      }

      const error = caught(() => fixture.manager.model({ provider: ROUTE, model: MODEL }))
      const code = codeOf(error)
      expect({
        ...context,
        instance: error instanceof AgentSdkError,
        stable: code !== undefined && CLOSED_CODES.has(code),
      }).toEqual({ ...context, instance: true, stable: true })
      if (moment === 'after-close-finished') {
        expect({ ...context, code }).toEqual({ ...context, code: 'RUNTIME_CLOSED' })
      }
      seen.add(moment)
    }

    // Every moment must actually have been generated, or the property above
    // would only speak about the ones that were.
    expect([...seen].sort()).toEqual([...CLOSE_MOMENTS].sort())
  })

  it('rejects a route that HAS an adapter, so lifecycle is checked before resolution', () => {
    const fixture = managerFixture()
    fixture.registry.registerEmbeddingAdapter([ROUTE], new FakeEmbeddingAdapter())
    void fixture.operations.beginClose({ timeoutMs: 10 }).catch(() => undefined)

    const error = caught(() => fixture.manager.model({ provider: ROUTE, model: MODEL }))
    expect(codeOf(error)).toBe('RUNTIME_CLOSING')
  })
})

// ---------------------------------------------------------------------------
// Scenario tests on a REAL runtime
// ---------------------------------------------------------------------------

/** Both plugin kinds go into the one `providers` list the owner accepts. */
function runtimeOptions(providers: RuntimeOwnerOptions['providers']): RuntimeOwnerOptions {
  return { providers }
}

function embeddingPlugin(adapter: FakeEmbeddingAdapter, route = ROUTE) {
  return defineEmbeddingProviderPlugin({
    id: `${route}-embedding`,
    displayName: 'Fake embedding route',
    routes: [route],
    setup(registrar) {
      registrar.registerEmbeddingAdapter(adapter)
      return undefined
    },
  })
}

describe('embeddingModel() on a real Agent_Runtime', () => {
  it('serves embedding with no agent, team or session anywhere in the runtime', async () => {
    const adapter = new FakeEmbeddingAdapter({ dimensions: 6 })
    // Embedding-only: there is no generation route and no default provider, so
    // an agent, team or session could not be constructed even if something tried.
    const owner = await createRuntimeCompositionOwner(runtimeOptions([embeddingPlugin(adapter)]))

    const handle = owner.embeddingModel({ provider: ROUTE, model: MODEL })
    const result = await handle.embedMany({
      values: ['tài liệu một', 'tài liệu hai'],
      purpose: 'retrieval-document',
    })
    expect(result.embeddings).toHaveLength(2)
    expect(result.space).toBe(expectedSpaceFor(undefined))
    expect(result.usage.inputsFromProvider).toBe(2)

    const report = await owner.close()
    expect(report.state).toBe('closed')
    // Nothing agent-shaped was ever built, so nothing agent-shaped is torn down.
    expect(report.components.map(row => row.kind)).toEqual(['provider-registration'])
    expect(report.operations.map(row => row.kind)).toContain('embedding-call')
    expect(report.operations.find(row => row.kind === 'agent-run')).toMatchObject({
      activeAtClose: 0, aborted: 0, settled: 0, unsettled: 0,
    })
    expect(report.activeRunsAtClose).toBe(0)
  })

  it('serves generation and rejects embedding on a runtime with only a generation plugin', async () => {
    const owner = await createRuntimeCompositionOwner(runtimeOptions([{
      kind: 'model-provider-plugin',
      apiVersion: 1,
      id: 'gen',
      displayName: 'Generation only',
      routes: ['gen'],
      setup(registrar) {
        registrar.registerAdapter(['gen'], new Generation())
      },
    }]))

    expect(owner.providers().map(row => row.id)).toEqual(['gen'])
    // A route carrying only a generation adapter is still a route without an
    // embedding adapter (Requirements 3.5, 11.8).
    expect(codeOf(caught(() => owner.embeddingModel({ provider: 'gen', model: MODEL }))))
      .toBe(EMBEDDING_ERROR_CODES.ADAPTER_MISSING)
    expect((await owner.close()).state).toBe('closed')
  })

  it('resolves generation and embedding independently when one route carries both', async () => {
    const adapter = new FakeEmbeddingAdapter()
    const owner = await createRuntimeCompositionOwner(runtimeOptions([
      {
        kind: 'model-provider-plugin',
        apiVersion: 1,
        id: 'both-generation',
        displayName: 'Shared route, generation',
        routes: ['shared'],
        setup(registrar) {
          registrar.registerAdapter(['shared'], new Generation())
        },
      },
      embeddingPlugin(adapter, 'shared'),
    ]))

    expect(owner.providers().map(row => row.id)).toEqual(['shared'])
    const result = await owner
      .embeddingModel({ provider: 'shared', model: MODEL })
      .embed({ value: 'chia sẻ route', purpose: 'retrieval-query' })
    expect(result.embedding.length).toBeGreaterThan(0)
    expect(adapter.attempts).toHaveLength(1)
    expect((await owner.close()).state).toBe('closed')
  })

  it('rejects `embeddingModel()` once close has begun and after it finished', async () => {
    const adapter = new FakeEmbeddingAdapter({ delayMs: 30 })
    const owner = await createRuntimeCompositionOwner(runtimeOptions([embeddingPlugin(adapter)]))
    const handle = owner.embeddingModel({ provider: ROUTE, model: MODEL })
    const inflight = handle
      .embedMany({ values: ['một', 'hai'], purpose: 'retrieval-document' })
      .catch((error: unknown) => error)

    const closing = owner.close()
    // Close has begun and quiescence has not finished: still a stable refusal.
    const duringClose = codeOf(caught(() => owner.embeddingModel({ provider: ROUTE, model: MODEL })))
    expect(duringClose !== undefined && CLOSED_CODES.has(duringClose)).toBe(true)

    await inflight
    expect((await closing).state).toBe('closed')
    expect(codeOf(caught(() => owner.embeddingModel({ provider: ROUTE, model: MODEL }))))
      .toBe('RUNTIME_CLOSED')
  })
})
