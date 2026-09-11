/**
 * Property and unit tests for `Embedding_Profile` and the derived `Space_Id`.
 *
 * Feature: embedding-support — Properties 14 and 17.
 *
 * **Validates: Requirements 6.3, 6.4, 7.4, 14.6**
 *
 * Space identity is the one decision the rest of the embedding surface cannot
 * recover from getting wrong: a wrong `Space_Id` silently mixes vectors that are
 * not comparable. So the assertions here enumerate the whole space each
 * requirement talks about — every normalization value, present and absent
 * post-processing, matching and differing dimension counts — rather than one
 * hand-picked profile pair.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/core/tests/unit/embedding/profile.spec.ts`. No runner
 * collects that directory: root `vitest.config.ts` includes `tests/**` and
 * `test-human/**` only, and the package-level configs include specs out of the
 * ROOT `tests/` tree by relative path. A spec under `packages/core/tests/unit/`
 * would never run in CI, which is the one failure mode a property test must not
 * have. It sits under the root tree beside the other core unit specs instead.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The convention the
 * existing property specs established (see
 * `tests/unit/provider-http/transport-session-properties.spec.ts`) is a seeded
 * mulberry32 generator: a failure reproduces from the printed seed and no new
 * dependency enters the graph for test-only reasons. Each property runs `RUNS`
 * generated cases, above the spec floor of 100.
 *
 * Property 22 is deliberately absent: it compares the vector a provider returned
 * against the vector handed out, so it needs an adapter and a response (tasks
 * 6.7, 12.4, 13.3).
 */

import { describe, expect, it } from 'vitest'
import {
  defaultEmbeddingProfile,
  deriveSpaceId,
  isSpaceCompatible,
  type EmbeddingNormalization,
  type EmbeddingPostProcessing,
  type EmbeddingProfile,
} from '../../../packages/core/src/embedding/profile.ts'
import {
  unknownEmbeddingModel,
  type ResolvedEmbeddingModelInfo,
} from '../../../packages/core/src/embedding/catalog.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'

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

/**
 * Identity strings a route can declare, including ones carrying the `|` and `\`
 * characters the canonical string has to escape.
 */
const IDENTITIES = [
  'openai:text-embedding-3-small',
  'openai:text-embedding-3-large',
  'gemini:gemini-embedding-001',
  'gemini:gemini-embedding-2',
  'self-hosted:bge-m3',
  'weird|route:model',
  'weird\\route:model',
  'weird\\|route:model',
] as const

const NORMALIZATIONS: readonly EmbeddingNormalization[] = ['unit-l2', 'none', 'unknown']

const DIMENSIONS = [256, 768, 1024, 1536, 3072] as const

const REVISIONS = ['1', '2', 'a|b', 'a\\b', '2024-06-01'] as const

const POST_PROCESSINGS: readonly (EmbeddingPostProcessing | undefined)[] = [
  undefined,
  { kind: 'l2-renormalize', revision: '1' },
  { kind: 'l2-renormalize', revision: '2' },
  { kind: 'l2-renormalize', revision: 'r|1' },
]

const PURPOSES: readonly EmbeddingPurpose[] = ['retrieval-query', 'retrieval-document']

function profileOf(rng: Rng, overrides: Partial<EmbeddingProfile> = {}): EmbeddingProfile {
  const postProcessing = pick(rng, POST_PROCESSINGS)
  return {
    modelIdentity: pick(rng, IDENTITIES),
    dimensions: pick(rng, DIMENSIONS),
    representation: 'dense-float32',
    normalization: pick(rng, NORMALIZATIONS),
    ...(postProcessing === undefined ? {} : { postProcessing }),
    documentRecipeRevision: pick(rng, REVISIONS),
    queryRecipeRevision: pick(rng, REVISIONS),
    compatibilityIdentity: pick(rng, IDENTITIES),
    profileRevision: pick(rng, REVISIONS),
    ...overrides,
  }
}

/** A resolved catalog entry that declares its own compatibility identity. */
function modelDeclaring(
  provider: string,
  id: string,
  compatibilityIdentity: string,
  defaultDimensions: number,
): ResolvedEmbeddingModelInfo {
  return {
    ...unknownEmbeddingModel(provider, id),
    representation: { state: 'supported', value: 'dense-float32' },
    defaultDimensions: { state: 'supported', value: defaultDimensions },
    compatibilityIdentity: { state: 'supported', value: compatibilityIdentity },
  }
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 14: space compatibility is decided by compatibility identity', () => {
  it('holds compatible when only model-level fields differ, and only then', () => {
    const rng = rngOf(0x1a2b_3c4d)

    for (let run = 0; run < RUNS; run += 1) {
      const seedProfile = profileOf(rng)

      // Model name, model revision and recipe revisions are NOT space
      // components: a group of models the provider declared to share a space
      // stays compatible across them (Requirement 6.7 in the design table).
      const sameSpace: EmbeddingProfile = {
        ...seedProfile,
        modelIdentity: pick(rng, IDENTITIES),
        modelRevision: pick(rng, REVISIONS),
        documentRecipeRevision: pick(rng, REVISIONS),
        queryRecipeRevision: pick(rng, REVISIONS),
      }
      expect(isSpaceCompatible(seedProfile, sameSpace)).toBe(true)
      expect(deriveSpaceId(sameSpace)).toBe(deriveSpaceId(seedProfile))

      // Same dimensions, different declared identity: NOT compatible. Equal
      // width is never a reason to treat two spaces as one (Requirement 6.4).
      const otherIdentity = IDENTITIES.filter((id) => id !== seedProfile.compatibilityIdentity)
      const differentIdentity: EmbeddingProfile = {
        ...seedProfile,
        modelIdentity: seedProfile.modelIdentity,
        compatibilityIdentity: pick(rng, otherIdentity),
      }
      expect(differentIdentity.dimensions).toBe(seedProfile.dimensions)
      expect(isSpaceCompatible(seedProfile, differentIdentity)).toBe(false)
      expect(deriveSpaceId(differentIdentity)).not.toBe(deriveSpaceId(seedProfile))

      // Same declared identity, different width: also not compatible, since
      // dimensions are part of the derivation.
      const otherDimensions = DIMENSIONS.filter((value) => value !== seedProfile.dimensions)
      const differentDimensions: EmbeddingProfile = {
        ...seedProfile,
        dimensions: pick(rng, otherDimensions),
      }
      expect(isSpaceCompatible(seedProfile, differentDimensions)).toBe(false)

      // Reflexive and symmetric, on every generated pair.
      expect(isSpaceCompatible(seedProfile, seedProfile)).toBe(true)
      expect(isSpaceCompatible(sameSpace, seedProfile)).toBe(
        isSpaceCompatible(seedProfile, sameSpace),
      )
    }
  })

  it('keeps two declared model generations in different spaces', () => {
    // Requirement 14.6: gemini-embedding-001 and gemini-embedding-2 declare
    // different identities, so they are not compatible even at equal width.
    const first = defaultEmbeddingProfile(
      modelDeclaring('gemini', 'gemini-embedding-001', 'gemini:embedding-001', 3072),
      {},
    )
    const second = defaultEmbeddingProfile(
      modelDeclaring('gemini', 'gemini-embedding-2', 'gemini:embedding-2', 3072),
      {},
    )

    expect(first.dimensions).toBe(second.dimensions)
    expect(isSpaceCompatible(first, second)).toBe(false)
    expect(deriveSpaceId(first)).not.toBe(deriveSpaceId(second))
  })

  it('keeps a declared model group in one space across model names', () => {
    const shared = 'openai:embedding-v3-space'
    const small = defaultEmbeddingProfile(
      modelDeclaring('openai', 'text-embedding-3-small', shared, 1536),
      { dimensions: 1536 },
    )
    const large = defaultEmbeddingProfile(
      modelDeclaring('openai', 'text-embedding-3-large', shared, 3072),
      { dimensions: 1536 },
    )

    expect(small.modelIdentity).not.toBe(large.modelIdentity)
    expect(isSpaceCompatible(small, large)).toBe(true)
    expect(deriveSpaceId(small)).toBe(deriveSpaceId(large))
  })
})

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 17: Space_Id is invariant when only purpose changes', () => {
  it('derives one Space_Id for query and document within a retrieval profile', () => {
    const rng = rngOf(0x5e6f_7a8b)

    for (let run = 0; run < RUNS; run += 1) {
      const model = modelDeclaring(
        pick(rng, ['openai', 'gemini', 'self-hosted']),
        pick(rng, ['text-embedding-3-small', 'gemini-embedding-001', 'bge-m3']),
        pick(rng, IDENTITIES),
        pick(rng, DIMENSIONS),
      )
      const dimensions = pick(rng, DIMENSIONS)
      const profileRevision = pick(rng, REVISIONS)
      const documentRecipeRevision = pick(rng, REVISIONS)
      const queryRecipeRevision = pick(rng, REVISIONS)

      // Purpose reaches the profile only through the recipe revisions, and those
      // are recorded rather than derived from (DD-7). One configuration, both
      // purposes: identical Space_Id (Requirement 7.4).
      const perPurpose = PURPOSES.map((purpose) => {
        const profile = defaultEmbeddingProfile(model, {
          dimensions,
          profileRevision,
          documentRecipeRevision,
          queryRecipeRevision,
        })
        return { purpose, profile, spaceId: deriveSpaceId(profile) }
      })

      const [query, document] = perPurpose as [
        (typeof perPurpose)[number],
        (typeof perPurpose)[number],
      ]
      expect(query.purpose).not.toBe(document.purpose)
      expect(query.spaceId).toBe(document.spaceId)
      expect(isSpaceCompatible(query.profile, document.profile)).toBe(true)

      // The same invariant stated directly on the profile: differing recipe
      // revisions — the only purpose-dependent fields — never move the space.
      const base = profileOf(rng, { dimensions })
      const otherRecipes: EmbeddingProfile = {
        ...base,
        documentRecipeRevision: pick(rng, REVISIONS),
        queryRecipeRevision: pick(rng, REVISIONS),
      }
      expect(deriveSpaceId(otherRecipes)).toBe(deriveSpaceId(base))
      expect(isSpaceCompatible(base, otherRecipes)).toBe(true)

      // Guard against the invariant being vacuous: a profileRevision change
      // does move the space, so the derivation is not simply ignoring inputs.
      const movedRevision: EmbeddingProfile = {
        ...base,
        profileRevision: pick(
          rng,
          REVISIONS.filter((revision) => revision !== base.profileRevision),
        ),
      }
      expect(deriveSpaceId(movedRevision)).not.toBe(deriveSpaceId(base))
    }
  })
})

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('deriveSpaceId', () => {
  it('returns a canonical string synchronously, not a Promise', () => {
    const rng = rngOf(0x0b_ad_c0de)
    const spaceId = deriveSpaceId(profileOf(rng))

    expect(typeof spaceId).toBe('string')
    expect(spaceId).not.toBeInstanceOf(Promise)
    expect((spaceId as unknown as { then?: unknown }).then).toBeUndefined()
    expect(spaceId.startsWith('emb:1|')).toBe(true)
  })

  it('never maps two different component tuples to the same canonical string', () => {
    // The pools include `|` and `\` on purpose: without escaping, tuples like
    // ('a|b', 'c') and ('a', 'b|c') would collide after the join.
    const tuples: EmbeddingProfile[] = []
    for (const compatibilityIdentity of IDENTITIES) {
      for (const normalization of NORMALIZATIONS) {
        for (const postProcessing of POST_PROCESSINGS) {
          for (const profileRevision of REVISIONS) {
            tuples.push({
              modelIdentity: 'fixed:model',
              dimensions: 1536,
              representation: 'dense-float32',
              normalization,
              ...(postProcessing === undefined ? {} : { postProcessing }),
              documentRecipeRevision: '1',
              queryRecipeRevision: '1',
              compatibilityIdentity,
              profileRevision,
            })
          }
        }
      }
    }

    const spaceIds = new Set(tuples.map((profile) => deriveSpaceId(profile)))

    expect(tuples.length).toBeGreaterThan(100)
    expect(spaceIds.size).toBe(tuples.length)
  })

  it('separates the escaped identities that would otherwise collide', () => {
    const rng = rngOf(0x1234_5678)
    const base = profileOf(rng, { profileRevision: '1', dimensions: 1536 })

    const left = deriveSpaceId({ ...base, compatibilityIdentity: 'a|b' })
    const right = deriveSpaceId({ ...base, compatibilityIdentity: 'a\\|b' })
    const escaped = deriveSpaceId({ ...base, compatibilityIdentity: 'a\\b' })

    expect(new Set([left, right, escaped]).size).toBe(3)
  })
})
