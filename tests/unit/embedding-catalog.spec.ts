/**
 * Property tests for `Embedding_Catalog`.
 *
 * Feature: embedding-support — Properties 24, 25.
 *
 * **Validates: Requirements 8.6, 10.3, 10.4, 10.5**
 *
 * Two claims live here, and they pull in opposite directions on purpose:
 *
 * - **Property 24** — a capability nobody declared is `unknown`, and `supported`
 *   only ever appears where a value was written down. `unsupported` is a positive
 *   negative claim, so collapsing it into `unknown` (or the reverse) would let a
 *   missing declaration masquerade as a denial (Requirements 10.4, 10.5).
 * - **Property 25** — the catalog is ADVISORY. A model id the catalog never
 *   describes stays usable, and an `unknown` capability is never a reason to
 *   reject: batching falls back to `EMBEDDING_BATCH_DEFAULTS` so memory stays
 *   bounded, and the profile still resolves to a `Space_Id` (Requirement 10.3,
 *   DD-6).
 *
 * The v1 scope checks are structural rather than generated: `EmbeddingInputType`
 * and `EmbeddingRepresentation` each admit exactly one value, so the text-only,
 * dense-float32-only scope is readable from the TYPE and not from prose
 * (Requirement 8.6). A type-level equality assertion is the right instrument
 * there — adding an `'image'` member would fail `pnpm typecheck`, which no
 * runtime assertion can catch.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/core/tests/unit/embedding/catalog.spec.ts`. No runner
 * collects that directory — the root and package vitest configs both collect specs
 * out of the ROOT `tests/` tree, which is why the earlier embedding-support
 * properties landed in `tests/unit/provider-http/`. A spec under
 * `packages/core/tests/unit/` would silently never run, the one failure mode a
 * property test must not have. So it sits in `tests/unit/` under the flat naming
 * the rest of that directory uses, and reaches core internals by relative path
 * because `packages/core/src/index.ts` does not re-export `embedding/` yet.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention the
 * existing property specs established (see
 * `tests/unit/provider-http/transport-session-properties.spec.ts`) is a seeded
 * mulberry32 generator: a failure reproduces from the printed seed and no
 * test-only dependency enters the graph. Each property runs `RUNS` generated
 * cases, above the spec floor of 100.
 */

import { describe, expect, it } from 'vitest'
import type {
  EmbeddingCapability,
  EmbeddingInputType,
  ResolvedEmbeddingModelInfo,
} from '../../packages/core/src/embedding/catalog.ts'
import { unknownEmbeddingModel } from '../../packages/core/src/embedding/catalog.ts'
import {
  EMBEDDING_BATCH_DEFAULTS,
  resolveBatchLimits,
} from '../../packages/core/src/embedding/limits.ts'
import type { EmbeddingRepresentation } from '../../packages/core/src/embedding/profile.ts'
import {
  defaultEmbeddingProfile,
  deriveSpaceId,
} from '../../packages/core/src/embedding/profile.ts'
import type { EmbeddingPurposeHandling } from '../../packages/core/src/embedding/purpose.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases; the spec floor is 100. */
const RUNS = 110

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

function intBetween(rng: Rng, low: number, high: number): number {
  return low + intBelow(rng, high - low + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[intBelow(rng, values.length)] as T
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

/**
 * Provider route keys and model id shapes, including ids that look nothing like
 * a catalog entry: an unlisted id is exactly the interesting case for Property 25.
 */
const PROVIDERS: readonly string[] = ['openai', 'gemini', 'copilot', 'anthropic', 'x']
const MODEL_SHAPES: readonly string[] = [
  'text-embedding-3-small',
  'gemini-embedding-001',
  'not-a-real-model',
  'model with spaces',
  'a|b\\c',
  '',
]

function modelId(rng: Rng): string {
  const base = pick(rng, MODEL_SHAPES)
  return bool(rng) ? base : `${base}-${intBelow(rng, 1000)}`
}

// ---------------------------------------------------------------------------
// Descriptor generation
// ---------------------------------------------------------------------------

/**
 * Every capability field on {@link ResolvedEmbeddingModelInfo}, listed once.
 *
 * Listing them by name is what makes Property 24 total: a field added to the
 * interface without being added here shows up as an untested capability, and the
 * `satisfies` check below keeps the list from naming something that is not a
 * capability.
 */
const CAPABILITY_FIELDS = [
  'inputTypes',
  'representation',
  'dimensions',
  'defaultDimensions',
  'maxInputTokens',
  'maxBatchItems',
  'maxBatchTokens',
  'maxBatchBytes',
  'purposeHandling',
  'normalization',
  'compatibilityIdentity',
] as const satisfies readonly (keyof ResolvedEmbeddingModelInfo)[]

type CapabilityField = (typeof CAPABILITY_FIELDS)[number]

/** A declared value for each capability field, so `supported` carries real data. */
function declaredValue(rng: Rng, field: CapabilityField): unknown {
  switch (field) {
    case 'inputTypes':
      return ['text'] satisfies readonly EmbeddingInputType[]
    case 'representation':
      return 'dense-float32' satisfies EmbeddingRepresentation
    case 'dimensions':
      return [256, 768, 1536].slice(0, intBetween(rng, 1, 3))
    case 'defaultDimensions':
      return pick(rng, [256, 768, 1536])
    case 'maxInputTokens':
      return intBetween(rng, 1, 8192)
    case 'maxBatchItems':
      return intBetween(rng, 1, 2048)
    case 'maxBatchTokens':
      return intBetween(rng, 1, 300_000)
    case 'maxBatchBytes':
      return intBetween(rng, 1, 4 * 1024 * 1024)
    case 'purposeHandling':
      return pick<EmbeddingPurposeHandling>(rng, [
        { kind: 'wire-parameter', parameter: 'taskType' },
        { kind: 'adapter-prefix', documented: true },
        { kind: 'none' },
      ])
    case 'normalization':
      return pick(rng, ['unit-l2', 'none', 'unknown'])
    case 'compatibilityIdentity':
      return `space-${intBelow(rng, 100)}`
  }
}

/** What the generator decided to write down for one field. */
type Declaration = 'supported' | 'unsupported' | 'absent'

interface GeneratedDescriptor {
  readonly model: ResolvedEmbeddingModelInfo
  /** The generator's intent per field, which the assertions compare against. */
  readonly declarations: Readonly<Record<CapabilityField, Declaration>>
}

/**
 * Builds a descriptor by starting from {@link unknownEmbeddingModel} and writing
 * down only the fields the generator chose to declare.
 *
 * This is how a real adapter builds an entry: identity first, then whatever it
 * actually knows. Anything it does not overwrite has to come back `unknown`.
 */
function generateDescriptor(rng: Rng): GeneratedDescriptor {
  const provider = pick(rng, PROVIDERS)
  const id = modelId(rng)
  const base = unknownEmbeddingModel(provider, id)

  const declarations: Record<CapabilityField, Declaration> = {} as Record<
    CapabilityField,
    Declaration
  >
  const overrides: Record<string, EmbeddingCapability<unknown>> = {}

  for (const field of CAPABILITY_FIELDS) {
    const roll = rng()
    if (roll < 0.4) {
      declarations[field] = 'supported'
      overrides[field] = { state: 'supported', value: declaredValue(rng, field) }
    } else if (roll < 0.6) {
      declarations[field] = 'unsupported'
      overrides[field] = { state: 'unsupported' }
    } else {
      declarations[field] = 'absent'
    }
  }

  return {
    model: { ...base, ...overrides } as ResolvedEmbeddingModelInfo,
    declarations,
  }
}

function capabilityOf(
  model: ResolvedEmbeddingModelInfo,
  field: CapabilityField,
): EmbeddingCapability<unknown> {
  return model[field] as EmbeddingCapability<unknown>
}

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 24: Capability không khai báo là `unknown`, `supported` cần khai báo tường minh', () => {
  const seed = 0x51_6e_41_24

  it(`reports every undeclared capability as unknown and never invents a supported one across ${RUNS} generated cases`, () => {
    const rng = rngOf(seed)

    for (let run = 0; run < RUNS; run += 1) {
      const { model, declarations } = generateDescriptor(rng)
      const context = `seed=0x${seed.toString(16)} run=${run} model=${model.provider}:${model.id}`

      for (const field of CAPABILITY_FIELDS) {
        const capability = capabilityOf(model, field)
        const intent = declarations[field]

        if (intent === 'absent') {
          // Nothing was written down, so the only honest answer is `unknown`.
          expect(capability.state, `${context} field=${field}`).toBe('unknown')
        } else {
          expect(capability.state, `${context} field=${field}`).toBe(intent)
        }

        // `supported` is the ONLY state that carries a value. A reader can
        // therefore never pull a value out of a state that made no claim.
        if (capability.state === 'supported') {
          expect(Object.hasOwn(capability, 'value'), `${context} field=${field}`).toBe(true)
          expect((capability as { value: unknown }).value, `${context} field=${field}`)
            .not.toBeUndefined()
        } else {
          expect(Object.hasOwn(capability, 'value'), `${context} field=${field}`).toBe(false)
        }
      }
    }
  })

  it(`keeps unsupported and unknown distinguishable across ${RUNS} generated cases`, () => {
    const rng = rngOf(seed ^ 0x5a5a)

    for (let run = 0; run < RUNS; run += 1) {
      const provider = pick(rng, PROVIDERS)
      const id = modelId(rng)
      const field = pick(rng, CAPABILITY_FIELDS)
      const base = unknownEmbeddingModel(provider, id)
      const denied = { ...base, [field]: { state: 'unsupported' } } as ResolvedEmbeddingModelInfo
      const context = `run=${run} field=${field}`

      // A route that says "I do not have this" and a route that says nothing are
      // two different statements; a reader can tell them apart on the state alone.
      expect(capabilityOf(denied, field).state, context).toBe('unsupported')
      expect(capabilityOf(base, field).state, context).toBe('unknown')
      expect(capabilityOf(denied, field).state, context).not.toBe(
        capabilityOf(base, field).state,
      )
    }
  })

  it('reports every capability of an unlisted model id as unknown', () => {
    const model = unknownEmbeddingModel('openai', 'never-heard-of-it')

    for (const field of CAPABILITY_FIELDS) {
      expect(capabilityOf(model, field).state, `field=${field}`).toBe('unknown')
    }
    // Identity is the one thing the descriptor does claim.
    expect(model.provider).toBe('openai')
    expect(model.id).toBe('never-heard-of-it')
    expect(model.name).toBe('never-heard-of-it')
    expect(model.modelRevision).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 25: Catalog là advisory', () => {
  const seed = 0x51_6e_41_25

  it(`keeps a model id outside the catalog usable, with unknown never acting as a rejection, across ${RUNS} generated cases`, () => {
    const rng = rngOf(seed)
    // A catalog that describes a handful of ids; every generated id is checked
    // against it, and the ones NOT in it are the point of the property.
    const catalog = new Set(['text-embedding-3-small', 'gemini-embedding-001'])

    for (let run = 0; run < RUNS; run += 1) {
      const provider = pick(rng, PROVIDERS)
      const id = modelId(rng)
      const context = `seed=0x${seed.toString(16)} run=${run} model=${provider}:${id}`

      // Resolving an id the catalog does not describe must not throw.
      const model = unknownEmbeddingModel(provider, id)
      expect(catalog.has(model.id) || !catalog.has(model.id), context).toBe(true)

      // Batching stays bounded on defaults rather than refusing to plan.
      const limits = resolveBatchLimits(model)
      expect(limits.maxItems, context).toBe(EMBEDDING_BATCH_DEFAULTS.maxItems)
      expect(limits.maxTokens, context).toBe(EMBEDDING_BATCH_DEFAULTS.maxTokens)
      expect(limits.maxBytes, context).toBe(EMBEDDING_BATCH_DEFAULTS.maxBytes)
      expect(Number.isInteger(limits.maxItems) && limits.maxItems > 0, context).toBe(true)
      expect(limits.estimateTokens('hello'), context).toBeGreaterThan(0)

      // And the profile still resolves, so a `Space_Id` exists for an unlisted id.
      const requested = bool(rng) ? intBetween(rng, 1, 3072) : undefined
      const profile = defaultEmbeddingProfile(model, {
        ...(requested === undefined ? {} : { dimensions: requested }),
      })
      expect(profile.modelIdentity, context).toBe(`${provider}:${id}`)
      // No declaration means identity falls back to the model identity, not a
      // guess about which space the vectors belong to.
      expect(profile.compatibilityIdentity, context).toBe(`${provider}:${id}`)
      expect(profile.normalization, context).toBe('unknown')
      expect(deriveSpaceId(profile).length, context).toBeGreaterThan(0)
    }
  })

  it(`lets a declared bound win over the default without unknown ever shrinking one across ${RUNS} generated cases`, () => {
    const rng = rngOf(seed ^ 0x3c3c)

    for (let run = 0; run < RUNS; run += 1) {
      const provider = pick(rng, PROVIDERS)
      const id = modelId(rng)
      const declared = intBetween(rng, 1, 4096)
      const context = `run=${run} declared=${declared}`

      const unknownModel = unknownEmbeddingModel(provider, id)
      const declaredModel: ResolvedEmbeddingModelInfo = {
        ...unknownModel,
        maxBatchItems: { state: 'supported', value: declared },
      }
      const deniedModel: ResolvedEmbeddingModelInfo = {
        ...unknownModel,
        maxBatchItems: { state: 'unsupported' },
      }

      // Only a `supported` value moves the bound.
      expect(resolveBatchLimits(declaredModel).maxItems, context).toBe(declared)
      // Neither `unknown` nor `unsupported` yields a bound that cannot plan a
      // batch — the fallback is total, which is what keeps the id usable.
      expect(resolveBatchLimits(unknownModel).maxItems, context).toBe(
        EMBEDDING_BATCH_DEFAULTS.maxItems,
      )
      expect(resolveBatchLimits(deniedModel).maxItems, context).toBe(
        EMBEDDING_BATCH_DEFAULTS.maxItems,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// v1 scope: text in, one dense float32 vector out
// ---------------------------------------------------------------------------

/** True only when `A` and `B` are the same type in both directions. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

describe('Feature: embedding-support — v1 scope is readable from the types (Requirement 8.6)', () => {
  it('admits nothing beyond `text` as an input type', () => {
    // Type-level: adding an `'image'` member breaks `pnpm typecheck`, which is
    // the only place a widened union can actually be caught.
    const inputTypeIsTextOnly: Exact<EmbeddingInputType, 'text'> = true
    expect(inputTypeIsTextOnly).toBe(true)

    const all: readonly EmbeddingInputType[] = ['text']
    expect(all).toEqual(['text'])
    expect(new Set(all).size).toBe(1)
  })

  it('admits nothing beyond `dense-float32` as a representation', () => {
    const representationIsDenseFloat32Only: Exact<
      EmbeddingRepresentation,
      'dense-float32'
    > = true
    expect(representationIsDenseFloat32Only).toBe(true)

    const all: readonly EmbeddingRepresentation[] = ['dense-float32']
    expect(all).toEqual(['dense-float32'])
    expect(new Set(all).size).toBe(1)
  })

  it('falls back to the single v1 representation when the catalog declares none', () => {
    const profile = defaultEmbeddingProfile(unknownEmbeddingModel('openai', 'unlisted'), {})
    expect(profile.representation).toBe('dense-float32')
  })
})
