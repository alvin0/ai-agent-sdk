/**
 * Property and unit tests for the optional `Embedding_Cache`: key derivation,
 * the space guard on read, and the cache/provider split in usage metadata.
 *
 * Feature: embedding-support — Properties 11, 12 and 13.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4**
 *
 * A cache is the one component here that can hand back a wrong answer without
 * anything failing: a key that is too coarse returns a vector produced under a
 * different configuration, and a stale entry returns a vector from a different
 * space. Both faults are silent at the call site, so the assertions below vary
 * each key component independently rather than trusting one hand-picked pair.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/cache-key.spec.ts`. No
 * runner collects that directory: root `vitest.config.ts` includes `tests/**`
 * and `test-human/**`, and the package configs reach specs in the ROOT `tests/`
 * tree by relative path. A spec under `packages/core/tests/unit/` would never
 * run in CI — the one failure mode a property test must not have. It sits beside
 * the other embedding unit specs (`profile.spec.ts`, `validation.spec.ts`,
 * `surface.spec.ts`) instead.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention the
 * existing property specs established is a seeded mulberry32 generator: a
 * failure reproduces from the printed seed and no dependency enters the graph
 * for test-only reasons. Each property runs `RUNS` generated cases, above the
 * spec floor of 100.
 */

import { describe, expect, it } from 'vitest'
import {
  embeddingCacheKey,
  readEmbeddingCacheEntry,
  resolveEmbeddingCache,
  writeEmbeddingCacheEntry,
  type EmbeddingCacheKeyInput,
} from '../../../packages/core/src/composition/embedding/cache.ts'
import {
  aggregateEmbeddingUsage,
  type EmbeddingBatchUsageEvidence,
} from '../../../packages/core/src/composition/embedding/usage.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheOptions,
  EmbeddingCacheStore,
} from '../../../packages/core/src/embedding/handle.ts'
import {
  deriveSpaceId,
  type EmbeddingPostProcessing,
  type EmbeddingProfile,
  type EmbeddingSpaceId,
} from '../../../packages/core/src/embedding/profile.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import type { EmbeddingContentPart } from '../../../packages/core/src/embedding/request.ts'

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

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

/** Picks a value from `values` that is not `current`; the pool must allow it. */
function pickOther<T>(rng: Rng, values: readonly T[], current: T): T {
  const others = values.filter((value) => value !== current)
  return pick(rng, others)
}

const SCOPES = ['tenant-a', 'tenant-b', 'tenant|a', 'tenant\\a', 'tenant\\|a'] as const

const IDENTITIES = [
  'openai:text-embedding-3-small',
  'openai:text-embedding-3-large',
  'gemini:gemini-embedding-001',
  'self-hosted:bge-m3',
  'weird|route:model',
  'weird\\route:model',
] as const

/**
 * Revision pool. `'none'` is deliberately absent: the key renders an absent
 * `modelRevision` as the literal `none`, so generating that string would make a
 * present revision indistinguishable from an absent one and the inequality
 * assertions would report a collision the design never claimed to avoid.
 */
const REVISIONS = ['1', '2', 'a|b', 'a\\b', '2024-06-01'] as const

const DIMENSIONS = [256, 768, 1024, 1536, 3072] as const

const POST_PROCESSINGS: readonly (EmbeddingPostProcessing | undefined)[] = [
  undefined,
  { kind: 'l2-renormalize', revision: '1' },
  { kind: 'l2-renormalize', revision: '2' },
  { kind: 'l2-renormalize', revision: 'r|1' },
]

const PURPOSES: readonly EmbeddingPurpose[] = ['retrieval-query', 'retrieval-document']

const TEXTS = ['hello', 'hello world', 'a|b', 'a\\b', '', 'xin chào', 'HELLO'] as const

function profileOf(rng: Rng, overrides: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  const postProcessing = pick(rng, POST_PROCESSINGS)
  return {
    modelIdentity: pick(rng, IDENTITIES),
    modelRevision: pick(rng, REVISIONS),
    dimensions: pick(rng, DIMENSIONS),
    representation: 'dense-float32',
    normalization: pick(rng, ['unit-l2', 'none', 'unknown'] as const),
    ...(postProcessing === undefined ? {} : { postProcessing }),
    documentRecipeRevision: pick(rng, REVISIONS),
    queryRecipeRevision: pick(rng, REVISIONS),
    compatibilityIdentity: pick(rng, IDENTITIES),
    profileRevision: pick(rng, REVISIONS),
    ...overrides,
  }
}

function contentPartsOf(rng: Rng): readonly EmbeddingContentPart[] {
  const count = 1 + intBelow(rng, 3)
  const parts: EmbeddingContentPart[] = []
  for (let index = 0; index < count; index += 1) {
    parts.push({ type: 'text', text: pick(rng, TEXTS) })
  }
  return parts
}

function keyInputOf(rng: Rng): EmbeddingCacheKeyInput {
  return {
    scope: pick(rng, SCOPES),
    profile: profileOf(rng),
    purpose: pick(rng, PURPOSES),
    contentParts: contentPartsOf(rng),
  }
}

type Revision = typeof REVISIONS[number]
type RecipeField = 'queryRecipeRevision' | 'documentRecipeRevision'

/** The recipe revision field the given purpose selects. */
function recipeFieldOf(purpose: EmbeddingPurpose): RecipeField {
  return purpose === 'retrieval-query' ? 'queryRecipeRevision' : 'documentRecipeRevision'
}

/** Replaces one recipe revision without letting a computed key widen the type. */
function withRecipe(profile: EmbeddingProfile, field: RecipeField, revision: string): EmbeddingProfile {
  return field === 'queryRecipeRevision'
    ? { ...profile, queryRecipeRevision: revision }
    : { ...profile, documentRecipeRevision: revision }
}

/** Replaces post-processing, omitting the key entirely when it moves to absent. */
function withPostProcessing(
  profile: EmbeddingProfile,
  postProcessing: EmbeddingPostProcessing | undefined,
): EmbeddingProfile {
  const { postProcessing: _dropped, ...rest } = profile
  return postProcessing === undefined ? rest : { ...rest, postProcessing }
}

/** A `Map`-backed store, which is the shape the option was designed around. */
function storeOf(entries: Iterable<readonly [string, EmbeddingCacheEntry]> = []): EmbeddingCacheStore {
  const map = new Map<string, EmbeddingCacheEntry>(entries as Iterable<[string, EmbeddingCacheEntry]>)
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry)
    },
  }
}

function cacheOf(scope: string, store: EmbeddingCacheStore = storeOf()): EmbeddingCacheOptions {
  return { scope, store }
}

function spaceOf(name: string): EmbeddingSpaceId {
  return name as EmbeddingSpaceId
}

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 11: cache key reflects exactly the five components', () => {
  it('yields an equal key for equal components and a different key when any one moves', async () => {
    const rng = rngOf(0x0cac_11e5)

    for (let run = 0; run < RUNS; run += 1) {
      const base = keyInputOf(rng)
      const key = await embeddingCacheKey(base)

      // Same five components, rebuilt from scratch: equal key. Structural
      // identity is not the reason — the objects are distinct instances.
      const twin: EmbeddingCacheKeyInput = {
        scope: base.scope,
        profile: { ...base.profile },
        purpose: base.purpose,
        contentParts: base.contentParts.map((part) => ({ ...part })),
      }
      expect(await embeddingCacheKey(twin)).toBe(key)

      // Component 1 — security scope.
      expect(
        await embeddingCacheKey({ ...base, scope: pickOther(rng, SCOPES, base.scope) }),
      ).not.toBe(key)

      // Component 2 — model identity, model revision and profile revision, each
      // varied on its own so a key that ignored one of the three would fail.
      expect(
        await embeddingCacheKey({
          ...base,
          profile: {
            ...base.profile,
            modelIdentity: pickOther(rng, IDENTITIES, base.profile.modelIdentity),
          },
        }),
      ).not.toBe(key)
      expect(
        await embeddingCacheKey({
          ...base,
          profile: {
            ...base.profile,
            modelRevision: pickOther(rng, REVISIONS, base.profile.modelRevision as Revision),
          },
        }),
      ).not.toBe(key)
      expect(
        await embeddingCacheKey({
          ...base,
          profile: {
            ...base.profile,
            profileRevision: pickOther(rng, REVISIONS, base.profile.profileRevision as Revision),
          },
        }),
      ).not.toBe(key)

      // Component 3 — purpose, and the recipe revision that purpose selects.
      const otherPurpose = pickOther(rng, PURPOSES, base.purpose)
      const selected = recipeFieldOf(base.purpose)
      const unselected = recipeFieldOf(otherPurpose)
      expect(await embeddingCacheKey({ ...base, purpose: otherPurpose })).not.toBe(key)
      expect(
        await embeddingCacheKey({
          ...base,
          profile: withRecipe(
            base.profile,
            selected,
            pickOther(rng, REVISIONS, base.profile[selected] as Revision),
          ),
        }),
      ).not.toBe(key)
      // The revision of the OTHER purpose is not part of this key: it would key
      // on a recipe this call never used.
      expect(
        await embeddingCacheKey({
          ...base,
          profile: withRecipe(
            base.profile,
            unselected,
            pickOther(rng, REVISIONS, base.profile[unselected] as Revision),
          ),
        }),
      ).toBe(key)

      // Component 4 — dimensions and post-processing.
      expect(
        await embeddingCacheKey({
          ...base,
          profile: { ...base.profile, dimensions: pickOther(rng, DIMENSIONS, base.profile.dimensions) },
        }),
      ).not.toBe(key)
      const otherPostProcessing = POST_PROCESSINGS.filter(
        (candidate) =>
          candidate?.kind !== base.profile.postProcessing?.kind
          || candidate?.revision !== base.profile.postProcessing?.revision,
      )
      const movedPostProcessing = pick(rng, otherPostProcessing)
      expect(
        await embeddingCacheKey({
          ...base,
          profile: withPostProcessing(base.profile, movedPostProcessing),
        }),
      ).not.toBe(key)

      // Component 5 — the digest of the effective input.
      const movedParts = [
        ...base.contentParts.slice(1),
        { type: 'text' as const, text: `${base.contentParts[0]?.text ?? ''}#moved` },
      ]
      expect(await embeddingCacheKey({ ...base, contentParts: movedParts })).not.toBe(key)
    }
  })

  it('ignores profile fields that are not key components', async () => {
    const rng = rngOf(0x11ff_00aa)

    for (let run = 0; run < RUNS; run += 1) {
      const base = keyInputOf(rng)
      const key = await embeddingCacheKey(base)

      // Normalization and compatibility identity describe the SPACE, not the
      // key: the space guard on read is what defends against them, so folding
      // them into the key would only fragment it (Requirement 5.3).
      const noise: EmbeddingProfile = {
        ...base.profile,
        normalization: pick(rng, ['unit-l2', 'none', 'unknown'] as const),
        compatibilityIdentity: pick(rng, IDENTITIES),
      }
      expect(await embeddingCacheKey({ ...base, profile: noise })).toBe(key)
    }
  })

  it('never maps two distinct component tuples to one key', async () => {
    // The pools carry `|` and `\` on purpose: without escaping, tuples such as
    // ('a|b', 'c') and ('a', 'b|c') would collide after the join.
    const inputs: EmbeddingCacheKeyInput[] = []
    for (const scope of SCOPES) {
      for (const modelIdentity of IDENTITIES) {
        for (const purpose of PURPOSES) {
          for (const text of TEXTS) {
            inputs.push({
              scope,
              purpose,
              contentParts: [{ type: 'text', text }],
              profile: {
                modelIdentity,
                dimensions: 1536,
                representation: 'dense-float32',
                normalization: 'unit-l2',
                documentRecipeRevision: '1',
                queryRecipeRevision: '1',
                compatibilityIdentity: 'fixed:space',
                profileRevision: '1',
              },
            })
          }
        }
      }
    }

    const keys = new Set(await Promise.all(inputs.map((input) => embeddingCacheKey(input))))

    expect(inputs.length).toBeGreaterThan(100)
    expect(keys.size).toBe(inputs.length)
  })

  it('separates content part boundaries and escaped text that would otherwise collide', async () => {
    const rng = rngOf(0x1234_abcd)
    const profile = profileOf(rng, { profileRevision: '1', dimensions: 1536 })
    const shared = { scope: 'tenant-a', profile, purpose: 'retrieval-document' as const }

    const joined = await embeddingCacheKey({ ...shared, contentParts: [{ type: 'text', text: 'a|b' }] })
    const split = await embeddingCacheKey({
      ...shared,
      contentParts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    })
    const escaped = await embeddingCacheKey({
      ...shared,
      contentParts: [{ type: 'text', text: 'a\\|b' }],
    })

    expect(new Set([joined, split, escaped]).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 12: a cache entry from another space is ignored', () => {
  it('returns the entry only when its space matches the prepared call', async () => {
    const rng = rngOf(0x5face_001)

    for (let run = 0; run < RUNS; run += 1) {
      const input = keyInputOf(rng)
      const key = await embeddingCacheKey(input)
      const space = deriveSpaceId(input.profile)
      const values = Object.freeze([0.1, 0.2, 0.3])

      // Same space: the entry is reused.
      const matching = cacheOf(input.scope, storeOf([[key, { values, space }]]))
      expect(await readEmbeddingCacheEntry(matching, key, space)).toEqual({ values, space })

      // Different space under the SAME key — exactly the collision a
      // configuration change that never moved `profileRevision` would produce.
      // The entry is discarded, so the item has to be embedded again.
      const foreign = deriveSpaceId({
        ...input.profile,
        compatibilityIdentity: pickOther(rng, IDENTITIES, input.profile.compatibilityIdentity),
      })
      expect(foreign).not.toBe(space)
      const stale = cacheOf(input.scope, storeOf([[key, { values, space: foreign }]]))
      expect(await readEmbeddingCacheEntry(stale, key, space)).toBeUndefined()

      // A differing width is the same story, and it is the case a caller is
      // most likely to hit by changing `dimensions` alone.
      const rewidened = deriveSpaceId({
        ...input.profile,
        dimensions: pickOther(rng, DIMENSIONS, input.profile.dimensions),
      })
      expect(rewidened).not.toBe(space)
      const rewidenedCache = cacheOf(input.scope, storeOf([[key, { values, space: rewidened }]]))
      expect(await readEmbeddingCacheEntry(rewidenedCache, key, space)).toBeUndefined()
    }
  })

  it('sends the ignored item to a new batch, and counts it as a provider input', async () => {
    const rng = rngOf(0x0b5_face)

    for (let run = 0; run < RUNS; run += 1) {
      const profile = profileOf(rng)
      const space = deriveSpaceId(profile)
      const foreign = deriveSpaceId({
        ...profile,
        compatibilityIdentity: pickOther(rng, IDENTITIES, profile.compatibilityIdentity),
      })
      const purpose = pick(rng, PURPOSES)
      const scope = pick(rng, SCOPES)
      const inputCount = 1 + intBelow(rng, 8)

      // Each item is prepopulated in the store, some under the current space and
      // some under a foreign one, so the only thing deciding a hit is the guard.
      const items = Array.from({ length: inputCount }, (_, index) => ({
        index,
        contentParts: [{ type: 'text' as const, text: `${pick(rng, TEXTS)}#${index}` }],
        stored: rng() < 0.5 ? space : foreign,
      }))
      const entries: [string, EmbeddingCacheEntry][] = []
      for (const item of items) {
        const key = await embeddingCacheKey({ scope, profile, purpose, contentParts: item.contentParts })
        entries.push([key, { values: [item.index], space: item.stored }])
      }
      const cache = cacheOf(scope, storeOf(entries))

      const misses: number[] = []
      for (const item of items) {
        const key = await embeddingCacheKey({ scope, profile, purpose, contentParts: item.contentParts })
        const entry = await readEmbeddingCacheEntry(cache, key, space)
        if (entry === undefined) misses.push(item.index)
        else expect(entry.space).toBe(space)
      }

      // Every foreign-space item fell through, and no same-space item did.
      expect(misses).toEqual(items.filter((item) => item.stored !== space).map((item) => item.index))

      // The misses become one `Physical_Batch`, and the usage report attributes
      // them to the provider rather than to the cache.
      const { report } = aggregateEmbeddingUsage({
        inputCount,
        batches: misses.length === 0
          ? []
          : [{ itemIndexes: misses, attempts: 1, usage: { inputTokens: misses.length } }],
      })
      expect(report.inputsFromProvider).toBe(misses.length)
      expect(report.inputsFromCache).toBe(inputCount - misses.length)
      expect(report.batches).toBe(misses.length === 0 ? 0 : 1)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 13: cache and provider input counts sum to the total', () => {
  it('reports inputsFromCache + inputsFromProvider === inputCount at every hit ratio', async () => {
    const rng = rngOf(0x13_0013)

    for (let run = 0; run < RUNS; run += 1) {
      const inputCount = 1 + intBelow(rng, 24)
      // A hit ratio drawn per run, including the two extremes: an all-cache
      // call must report zero provider inputs, and an all-miss call zero cache
      // inputs. Neither may be a special case in the aggregator.
      const hitRatio = pick(rng, [0, 0.25, 0.5, 0.75, 1, rng()])
      const missIndexes = Array.from({ length: inputCount }, (_, index) => index).filter(
        () => rng() >= hitRatio,
      )

      // The misses are split across several batches so the count is a distinct
      // input set rather than a per-batch length sum.
      const batchSize = 1 + intBelow(rng, 5)
      const batches: EmbeddingBatchUsageEvidence[] = []
      for (let start = 0; start < missIndexes.length; start += batchSize) {
        const itemIndexes = missIndexes.slice(start, start + batchSize)
        batches.push({
          itemIndexes,
          attempts: 1 + intBelow(rng, 3),
          // Some batches report no usage at all, which must change the status
          // but never the input accounting.
          ...(rng() < 0.75 ? { usage: { inputTokens: itemIndexes.length * 4 } } : {}),
        })
      }

      const { report } = aggregateEmbeddingUsage({ inputCount, batches })

      expect(report.inputsFromCache + report.inputsFromProvider).toBe(inputCount)
      expect(report.inputsFromProvider).toBe(missIndexes.length)
      expect(report.inputsFromCache).toBe(inputCount - missIndexes.length)
      // Reported separately, as two numbers a caller can read on their own.
      expect(Number.isSafeInteger(report.inputsFromCache)).toBe(true)
      expect(Number.isSafeInteger(report.inputsFromProvider)).toBe(true)
      expect(report.inputsFromCache).toBeGreaterThanOrEqual(0)
      expect(report.inputsFromProvider).toBeGreaterThanOrEqual(0)
    }
  })

  it('holds when the same input is retried across several batches', () => {
    // A retried item appears in more than one batch. It is still ONE input, so
    // counting batch lengths would push the sum past `inputCount`.
    const { report } = aggregateEmbeddingUsage({
      inputCount: 3,
      batches: [
        { itemIndexes: [0, 1], attempts: 2, usage: { inputTokens: 8 } },
        { itemIndexes: [1], attempts: 1, usage: { inputTokens: 4 } },
      ],
    })

    expect(report.inputsFromProvider).toBe(2)
    expect(report.inputsFromCache).toBe(1)
    expect(report.inputsFromCache + report.inputsFromProvider).toBe(3)
    expect(report.providerAttempts).toBe(3)
  })

  it('attributes every input to the cache when no batch was dispatched', () => {
    const { report } = aggregateEmbeddingUsage({ inputCount: 5, batches: [] })

    expect(report.inputsFromCache).toBe(5)
    expect(report.inputsFromProvider).toBe(0)
    // No batch ran, so there is no usage to claim knowledge of.
    expect(report.status).toBe('missing')
    expect(report.tokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Configuration: off by default, and no default scope (DD-8)
// ---------------------------------------------------------------------------

describe('resolveEmbeddingCache', () => {
  it('reports the cache off when no options are supplied', () => {
    // Requirement 5.1: absent options are not an error, they mean disabled —
    // which is also what keeps `crypto.subtle` off the mandatory path (DD-11).
    expect(resolveEmbeddingCache(undefined)).toBeUndefined()
  })

  it('rejects a missing or empty scope as EMBEDDING_CONFIGURATION_INVALID', () => {
    const store = storeOf()

    for (const scope of [undefined, null, '', 0, {}] as unknown[]) {
      const options = { store, scope } as unknown as EmbeddingCacheOptions
      let thrown: unknown
      try {
        resolveEmbeddingCache(options)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(EmbeddingError)
      expect((thrown as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
    }
  })

  it('rejects a store that cannot answer get and set', () => {
    for (const store of [undefined, null, {}, { get: () => undefined }, 'store'] as unknown[]) {
      const options = { store, scope: 'tenant-a' } as unknown as EmbeddingCacheOptions
      expect(() => resolveEmbeddingCache(options)).toThrow(EmbeddingError)
      try {
        resolveEmbeddingCache(options)
      } catch (error) {
        expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
      }
    }
  })

  it('returns the options untouched when scope and store are usable', () => {
    const options = cacheOf('tenant-a')

    expect(resolveEmbeddingCache(options)).toBe(options)
  })
})

describe('cache store faults', () => {
  it('treats corrupt payloads as misses and detaches valid cache values', async () => {
    const space = spaceOf('emb:1|test')
    for (const entry of [null, { space, values: [NaN] }, { space, values: [Infinity] },
      { space, values: [] }, { space, values: new Array(2) }, { space, values: 'bad' }]) {
      const cache = cacheOf('tenant-a', { get: () => entry as unknown as EmbeddingCacheEntry, set() {} })
      await expect(readEmbeddingCacheEntry(cache, 'key', space)).resolves.toBeUndefined()
    }
    const values = [1, 2]
    const cache = cacheOf('tenant-a', { get: () => ({ space, values }), set() {} })
    const hit = await readEmbeddingCacheEntry(cache, 'key', space)
    values[0] = 99
    expect(hit?.values).toEqual([1, 2])
    expect(Object.isFrozen(hit?.values)).toBe(true)
  })

  it('treats a throwing get as a miss and a throwing set as a no-op', async () => {
    const faulty: EmbeddingCacheStore = {
      get: () => {
        throw new Error('store unavailable')
      },
      set: () => {
        throw new Error('store unavailable')
      },
    }
    const cache = cacheOf('tenant-a', faulty)
    const space = spaceOf('emb:1|test')

    // A cache is an optimisation: it may not be able to fail a call.
    await expect(readEmbeddingCacheEntry(cache, 'key', space)).resolves.toBeUndefined()
    await expect(writeEmbeddingCacheEntry(cache, 'key', { values: [1], space })).resolves
      .toBeUndefined()
  })

  it('round-trips a written entry through the store', async () => {
    const cache = cacheOf('tenant-a')
    const space = spaceOf('emb:1|test')

    await writeEmbeddingCacheEntry(cache, 'key', { values: [1, 2], space })

    expect(await readEmbeddingCacheEntry(cache, 'key', space)).toEqual({ values: [1, 2], space })
    expect(await readEmbeddingCacheEntry(cache, 'key', spaceOf('emb:1|other'))).toBeUndefined()
  })
})
