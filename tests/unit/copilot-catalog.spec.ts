/**
 * Property tests for `Copilot_Catalog`.
 *
 * Feature: github-copilot-provider — Properties 27, 28, 29, 30, 31.
 *
 * The module under test answers one question in two very different ways, and the
 * difference IS the contract: a body that is the wrong shape STRUCTURALLY is an
 * error, while a single entry that is merely unfamiliar is dropped and the rest of
 * the catalog survives. Properties 28 and 31 pin the two halves against each
 * other, so an implementation cannot quietly move a case from one to the other.
 *
 * Property 29 covers the trap this surface is most likely to fail on: metadata is
 * TRANSLATED, never invented. With no vision signal at all `inputModalities` must
 * be ABSENT, not `['text']` — an explicit list without `image` is a negative claim
 * the registry acts on by projecting images to text, so inventing it would
 * silently strip images from requests to a model that may well accept them.
 *
 * Inputs come from a SEEDED generator rather than `Math.random`, so a failure
 * reproduces from the printed seed. The repository carries no property-testing
 * library, so the generators live here, following
 * `tests/unit/chat-completions-serialize.spec.ts` and
 * `tests/unit/copilot-auth-store.spec.ts`.
 */

import { readFile, readdir } from 'node:fs/promises'
import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import type {
  ProviderCatalogModel,
  RuntimeModelDiscoveryContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import { describe, expect, it } from 'vitest'
import { COPILOT_BASE_URL } from '../../packages/provider-copilot/src/adapter.ts'
import {
  COPILOT_CATALOG_PATH,
  COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  copilotCatalogCacheOptions,
  discoverCopilotModels,
  partitionCopilotCatalog,
  resolveCopilotCatalogLimits,
  type CopilotCatalogLimits,
  type CopilotCatalogSnapshot,
} from '../../packages/provider-copilot/src/catalog.ts'
import { COPILOT_ERROR_CODES } from '../../packages/provider-copilot/src/common/error-codes.ts'
import { copilotFetch, copilotUrl, issuerOf } from '../../packages/provider-copilot/src/common/http.ts'

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
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('empty choice list')
  return value
}

/** `pick` for lists that legitimately contain `undefined` or `null` as a case. */
function pickLoose<T>(rng: Rng, values: readonly T[]): T {
  if (values.length === 0) throw new Error('empty choice list')
  return values[intBelow(rng, values.length)] as T
}

function bool(rng: Rng): boolean {
  return rng() < 0.5
}

// ---------------------------------------------------------------------------
// Shared doubles
// ---------------------------------------------------------------------------

const LIMITS: CopilotCatalogLimits = resolveCopilotCatalogLimits()

const CATALOG_URL = copilotUrl(issuerOf('baseUrl', COPILOT_BASE_URL, COPILOT_BASE_URL), COPILOT_CATALOG_PATH)

/** One dispatched request, recorded so "how many calls to `/models`" is answerable. */
interface Dispatch {
  readonly url: string
  readonly method: string | undefined
}

interface FetchDouble {
  readonly fetch: typeof globalThis.fetch
  readonly dispatched: readonly Dispatch[]
}

/**
 * A fetch that answers with a real `Response`.
 *
 * Real rather than a literal, because the bounded reader in `common/http.ts` walks
 * an actual `ReadableStream` and reads `content-length` — a hand-built object would
 * test the double instead of the reader. A fresh `Response` reports `url: ''`,
 * which the redirect guard deliberately treats as "not a redirect".
 */
function fetchDouble(reply: (url: string) => { status?: number; body?: string }): FetchDouble {
  const dispatched: Dispatch[] = []
  const fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input)
    dispatched.push({ url, method: init?.method })
    const { status = 200, body = '' } = reply(url)
    return Promise.resolve(new Response(status === 204 ? null : body, {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof globalThis.fetch
  return { fetch, dispatched }
}

/** A discovery context of the shape `provider-http` hands to `discoverModels`. */
function discoveryContext(): RuntimeModelDiscoveryContext {
  return {
    provider: 'copilot',
    baseUrl: new URL(COPILOT_BASE_URL),
    headers: Object.freeze({ authorization: 'Bearer tid=secret', 'copilot-integration-id': 'vscode-chat' }),
    signal: new AbortController().signal,
  }
}

function errorOf(value: unknown): AgentSdkError {
  expect(value).toBeInstanceOf(AgentSdkError)
  return value as AgentSdkError
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
    return undefined
  } catch (error: unknown) {
    return error
  }
}

const fixture = async (name: string): Promise<string> => readFile(
  new URL(`../../packages/provider-copilot/fixtures/${name}`, import.meta.url),
  'utf8',
)

/** Run a full discovery against a fixture, so the fetch path is exercised too. */
async function discoverFixture(
  name: string,
  limits: CopilotCatalogLimits = LIMITS,
): Promise<{ snapshot?: CopilotCatalogSnapshot; error?: unknown; dispatched: readonly Dispatch[] }> {
  const body = await fixture(name)
  const double = fetchDouble(() => ({ body }))
  try {
    const snapshot = await discoverCopilotModels(discoveryContext(), limits, double.fetch)
    return { snapshot, dispatched: double.dispatched }
  } catch (error: unknown) {
    return { error, dispatched: double.dispatched }
  }
}

// ---------------------------------------------------------------------------
// Fixture-level cover
//
// The examples come first: they say what the real endpoint shapes are, and the
// generated properties below say what must hold for every shape.
// ---------------------------------------------------------------------------

describe('Copilot catalog fixtures', () => {
  it('reads models-ok.json as five chat models, each metadata case intact', async () => {
    const { snapshot, dispatched } = await discoverFixture('models-ok.json')
    expect(dispatched).toEqual([{ url: CATALOG_URL, method: 'GET' }])
    expect(snapshot?.embedding).toEqual([])
    expect(snapshot?.omitted).toEqual([])

    const generation = snapshot?.generation ?? []
    expect(generation.map(entry => entry.model.id)).toEqual([
      'gpt-4o', 'gpt-4.1', 'o3-mini', 'gpt-4o-mini', 'claude-sonnet-4',
    ])

    // `supports.vision` and the top-level `vision` flag are the two shapes the
    // signal arrives in; both must produce the same explicit modality list.
    expect(generation[0]?.model).toEqual({
      id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384,
      inputModalities: ['text', 'image'],
    })
    expect(generation[1]?.model.inputModalities).toEqual(['text', 'image'])

    // No vision signal ⇒ the key is absent, NOT `['text']`.
    expect(generation[2]?.model).toEqual({
      id: 'o3-mini', name: 'o3-mini', contextWindow: 200_000, maxTokens: 100_000,
    })
    expect(Object.keys(generation[2]?.model ?? {})).not.toContain('inputModalities')

    // The three states of the endpoint disclosure, in one fixture.
    expect(generation[2]?.declaredEndpoint).toBe('responses')
    expect(generation[3]?.declaredEndpoint).toBe('chat-completions')
    expect(generation[0]?.declaredEndpoint).toBeUndefined()

    // An entry with neither a name nor limits keeps just its id: a display label
    // the endpoint did not send is a label this layer would be inventing.
    expect(generation[4]?.model).toEqual({ id: 'claude-sonnet-4' })
  })

  it('partitions models-mixed-types.json into two chat and two embedding models', async () => {
    const { snapshot } = await discoverFixture('models-mixed-types.json')
    expect(snapshot?.generation.map(entry => entry.model.id)).toEqual(['gpt-4o', 'o3-mini'])
    expect(snapshot?.embedding).toEqual([
      {
        id: 'text-embedding-3-small', name: 'Embedding V3 small',
        family: 'text-embedding-3-small', maxInputTokens: 8_192, maxInputs: 256,
        supportsDimensions: true,
      },
      {
        id: 'text-embedding-3-small-inference', name: 'Embedding V3 small (Inference)',
        family: 'text-embedding-3-small', maxInputs: 64, supportsDimensions: true,
      },
    ])
    expect(snapshot?.omitted).toEqual([])
  })

  it('drops the strange entries of models-unknown-type.json and keeps the usable one', async () => {
    const { snapshot } = await discoverFixture('models-unknown-type.json')
    expect(snapshot?.generation.map(entry => entry.model.id)).toEqual(['gpt-4o'])
    expect(snapshot?.embedding).toEqual([])
    expect(snapshot?.omitted).toEqual([
      { id: 'code-davinci-002', reason: 'capability-type-unrecognized' },
      { id: 'copilot-audio-preview', reason: 'capability-type-unrecognized' },
      { id: 'copilot-untyped-preview', reason: 'capability-type-unrecognized' },
      { id: '', reason: 'model-id-missing' },
      { id: '', reason: 'model-id-missing' },
    ])
  })

  it('answers an empty snapshot, not an error, for a non-2xx catalog status', async () => {
    // A catalog that could not be fetched is advisory too: discovery failing is not
    // a reason to fail the operation that triggered it.
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const double = fetchDouble(() => ({ status, body: '{"error":"nope"}' }))
      const snapshot = await discoverCopilotModels(discoveryContext(), LIMITS, double.fetch)
      expect(snapshot, `status ${String(status)}`)
        .toEqual({ generation: [], embedding: [], omitted: [] })
    }
  })

  it('forwards only the cache options the caller set, and validates the per-read bounds', () => {
    expect(copilotCatalogCacheOptions()).toEqual({})
    expect(Object.keys(copilotCatalogCacheOptions({ catalogTtlMs: 5 }))).toEqual(['catalogTtlMs'])
    expect(copilotCatalogCacheOptions({ catalogTtlMs: 5, catalogStaleTtlMs: 6, catalogFailureBackoffMs: 7 }))
      .toEqual({ catalogTtlMs: 5, catalogStaleTtlMs: 6, catalogFailureBackoffMs: 7 })
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveCopilotCatalogLimits({ maxCatalogModels: bad })).toThrow(RangeError)
    }
    expect(LIMITS.maxModels).toBe(COPILOT_DEFAULT_MAX_CATALOG_MODELS)
  })
})

// ---------------------------------------------------------------------------
// Property 27
//
// The half of this property that lives in the ADAPTER — "a configuration carrying
// `models` never calls discovery" — cannot be asserted against the adapter yet:
// `src/adapter.ts` is still only the `Client_Identity_Constants` at this point in
// the plan, and the wiring lands in task 9.1. What is asserted here is everything
// that is assertable without it, and it is the part that makes the adapter claim
// checkable at all:
//
//   1. `discoverCopilotModels` is the ONLY code path in the package that issues a
//      request to `/models` — so "no discovery" and "no `/models` request" are the
//      same statement, and task 9.1 only has to be shown not to call it.
//   2. Taking the supplied-`models` branch dispatches zero requests and yields
//      exactly the supplied list.
//   3. Taking the absent-`models` branch dispatches exactly one GET to
//      `{baseUrl}/models` and yields the discovered list.
//
// Points 2 and 3 run through a local stand-in for the adapter's branch, marked as
// such. Task 9.1 owes the assertion that the real adapter takes these branches.
// ---------------------------------------------------------------------------

/**
 * The adapter's documented branch, written here because the adapter has not been
 * built yet (task 9.1). Deliberately three lines: any more and this would be
 * testing a second implementation rather than the branch condition.
 */
async function catalogFor(
  options: { readonly models?: readonly ProviderCatalogModel[] },
  fetchImpl: typeof globalThis.fetch,
): Promise<readonly ProviderCatalogModel[]> {
  if (options.models !== undefined) return options.models
  const snapshot = await discoverCopilotModels(discoveryContext(), LIMITS, fetchImpl)
  return snapshot.generation.map(entry => entry.model)
}

function generatedModels(rng: Rng): readonly ProviderCatalogModel[] {
  return Array.from({ length: 1 + intBelow(rng, 4) }, (_unused, index) => ({
    id: `supplied-${String(index)}-${String(intBelow(rng, 1_000))}`,
    ...(bool(rng) ? { name: `Supplied ${String(index)}` } : {}),
    ...(bool(rng) ? { contextWindow: 1_000 * (1 + intBelow(rng, 128)) } : {}),
  }))
}

describe('Feature: github-copilot-provider, Property 27: Truyền `models` thì không phát hiện, không truyền thì phát hiện', () => {
  it('keeps `/models` behind discoverCopilotModels, so no other path can reach the catalog', async () => {
    const root = new URL('../../packages/provider-copilot/src/', import.meta.url)
    const files = await readdir(root, { recursive: true, withFileTypes: true })
    const touching: string[] = []
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const path = `${entry.parentPath}/${entry.name}`.replace(/\/+/gu, '/')
      const source = await readFile(path, 'utf8')
      // The literal path and the exported constant are the two ways to name it.
      if (/'\/models'|COPILOT_CATALOG_PATH/u.test(source)) {
        touching.push(path.split('/src/')[1] ?? path)
      }
    }
    // `index.ts` re-exports the constant; only `catalog.ts` may USE it.
    expect(touching.sort()).toEqual(['catalog.ts', 'index.ts'])
  })

  it('dispatches zero requests and returns the supplied list verbatim when `models` is given', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed)
      const trace = `seed ${String(seed)}`
      const models = generatedModels(rng)
      const double = fetchDouble(() => {
        throw new Error('discovery must not run when `models` was supplied')
      })

      const catalog = await catalogFor({ models }, double.fetch)

      expect(double.dispatched, `${trace}: requests to /models`).toEqual([])
      // Verbatim: same entries, same order, and not a re-derived copy.
      expect(catalog, trace).toBe(models)
      expect(catalog, trace).toEqual(models)
    }
  })

  it('dispatches exactly one GET to {baseUrl}/models when `models` is absent', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 1_000)
      const trace = `seed ${String(seed)}`
      const ids = Array.from({ length: 1 + intBelow(rng, 5) }, (_unused, index) =>
        `discovered-${String(seed)}-${String(index)}`)
      const body = JSON.stringify({
        object: 'list',
        data: ids.map(id => ({ id, capabilities: { type: 'chat' } })),
      })
      const double = fetchDouble(() => ({ body }))

      const catalog = await catalogFor({}, double.fetch)

      expect(double.dispatched, trace).toEqual([{ url: CATALOG_URL, method: 'GET' }])
      expect(catalog.map(model => model.id), trace).toEqual(ids)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 28
// ---------------------------------------------------------------------------

/** How one generated entry must be classified. */
type Classification =
  | { readonly kind: 'generation' }
  | { readonly kind: 'embedding' }
  | { readonly kind: 'omitted'; readonly id: string; readonly reason: 'model-id-missing' | 'capability-type-unrecognized' }

interface EntryCase {
  readonly entry: unknown
  readonly id: string
  readonly classification: Classification
  readonly label: string
}

/** `capabilities.type` values that are recognizable, and the catalog each feeds. */
const RECOGNIZED = Object.freeze({ chat: 'generation', embeddings: 'embedding' } as const)

/**
 * Type values that must NOT be recognized.
 *
 * The near-misses matter more than the obvious ones: `'Chat'`, `'CHAT'` and
 * `'embedding'` are the values a case-insensitive or singular-tolerant match would
 * wrongly accept, and accepting one would put a model in a selector that cannot
 * dispatch it (Requirements 9.4, 9.5).
 */
const UNRECOGNIZED_TYPES: readonly unknown[] = Object.freeze([
  'completions', 'audio', 'Chat', 'CHAT', 'embedding', 'Embeddings', '', ' chat',
  42, true, false, null, ['chat'], { type: 'chat' },
])

/** Values in the `id` position that cannot serve as a wire model id. */
const UNUSABLE_IDS: readonly unknown[] = Object.freeze([undefined, '', null, 42, {}, [], true])

function buildEntryCase(rng: Rng, index: number): EntryCase {
  const id = `model-${String(index)}`
  switch (pick(rng, [
    'chat', 'chat', 'embeddings', 'embeddings', 'unrecognized', 'unrecognized',
    'no-capabilities', 'bad-id', 'bad-id', 'not-an-object',
  ] as const)) {
    case 'chat':
      return {
        entry: { id, capabilities: { type: 'chat' } },
        id, label: 'chat', classification: { kind: 'generation' },
      }
    case 'embeddings':
      return {
        entry: { id, capabilities: { type: 'embeddings' } },
        id, label: 'embeddings', classification: { kind: 'embedding' },
      }
    case 'unrecognized': {
      const type = pickLoose(rng, UNRECOGNIZED_TYPES)
      return {
        entry: { id, capabilities: { type } },
        id, label: `type ${JSON.stringify(type) ?? 'undefined'}`,
        classification: { kind: 'omitted', id, reason: 'capability-type-unrecognized' },
      }
    }
    case 'no-capabilities':
      return {
        // `capabilities` absent entirely, or present with no `type`.
        entry: bool(rng) ? { id } : { id, capabilities: { family: 'x' } },
        id, label: 'no type', classification: { kind: 'omitted', id, reason: 'capability-type-unrecognized' },
      }
    case 'bad-id': {
      const badId = pickLoose(rng, UNUSABLE_IDS)
      // A recognizable type does not rescue an unusable id: the id gate runs first,
      // and it must, because a catalog entry with no id names nothing.
      const type = pickLoose(rng, ['chat', 'embeddings', 'completions', undefined] as const)
      return {
        entry: { ...(badId === undefined ? {} : { id: badId }), capabilities: { type } },
        id: '', label: `bad id ${JSON.stringify(badId) ?? 'undefined'}`,
        classification: { kind: 'omitted', id: '', reason: 'model-id-missing' },
      }
    }
    default: {
      const entry = pickLoose(rng, [null, 42, 'gpt-4o', true, [{ id: 'gpt-4o' }]] as const)
      return {
        entry, id: '', label: `non-object ${JSON.stringify(entry) ?? 'undefined'}`,
        classification: { kind: 'omitted', id: '', reason: 'model-id-missing' },
      }
    }
  }
}

describe('Feature: github-copilot-provider, Property 28: Phân hoạch catalog theo `Model_Capability_Type`', () => {
  it('names both recognized types and rejects every near-miss spelling', () => {
    // The table itself, asserted once: the generated runs below are only as strong
    // as the two values they treat as recognizable.
    for (const [type, target] of Object.entries(RECOGNIZED)) {
      const snapshot = partitionCopilotCatalog(
        { data: [{ id: 'x', capabilities: { type } }] }, 8)
      expect(target === 'generation' ? snapshot.generation.length : snapshot.embedding.length, type).toBe(1)
      expect(snapshot.omitted, type).toEqual([])
    }
    for (const type of UNRECOGNIZED_TYPES) {
      const snapshot = partitionCopilotCatalog({ data: [{ id: 'x', capabilities: { type } }] }, 8)
      const trace = `type ${JSON.stringify(type) ?? 'undefined'}`
      expect(snapshot.generation, trace).toEqual([])
      expect(snapshot.embedding, trace).toEqual([])
      expect(snapshot.omitted, trace).toEqual([{ id: 'x', reason: 'capability-type-unrecognized' }])
    }
  })

  it('places every entry in exactly one of the three lists, with its reason', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 2_000)
      const trace = `seed ${String(seed)}`
      const cases = Array.from({ length: 1 + intBelow(rng, 12) }, (_unused, index) =>
        buildEntryCase(rng, index))

      const snapshot = partitionCopilotCatalog({ data: cases.map(entry => entry.entry) }, 64)

      const expected = {
        generation: cases.flatMap(c => c.classification.kind === 'generation' ? [c.id] : []),
        embedding: cases.flatMap(c => c.classification.kind === 'embedding' ? [c.id] : []),
        omitted: cases.flatMap(c => c.classification.kind === 'omitted'
          ? [{ id: c.classification.id, reason: c.classification.reason }]
          : []),
      }
      const labels = cases.map(c => c.label).join(' | ')

      expect(snapshot.generation.map(entry => entry.model.id), `${trace}: ${labels}`)
        .toEqual(expected.generation)
      expect(snapshot.embedding.map(entry => entry.id), `${trace}: ${labels}`)
        .toEqual(expected.embedding)
      expect(snapshot.omitted, `${trace}: ${labels}`).toEqual(expected.omitted)

      // Nothing is lost and nothing is duplicated: the three lists partition the
      // input, which is the whole claim of "exactly one of two catalogs".
      expect(
        snapshot.generation.length + snapshot.embedding.length + snapshot.omitted.length,
        `${trace}: total entries`,
      ).toBe(cases.length)

      // And no id is in both catalogs — including the omitted ids, which must be in
      // neither. Listing a model this SDK cannot dispatch is worse than not listing
      // it, because it fails at call time instead.
      const generationIds = new Set(snapshot.generation.map(entry => entry.model.id))
      for (const id of snapshot.embedding.map(entry => entry.id)) {
        expect(generationIds.has(id), `${trace}: ${id} in both catalogs`).toBe(false)
      }
      for (const omitted of snapshot.omitted) {
        if (omitted.id.length === 0) continue
        expect(generationIds.has(omitted.id), `${trace}: omitted ${omitted.id} in generation`).toBe(false)
        expect(
          snapshot.embedding.some(entry => entry.id === omitted.id),
          `${trace}: omitted ${omitted.id} in embedding`,
        ).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 29
// ---------------------------------------------------------------------------

/** One generated field: what went on the wire, and what the model must carry. */
interface FieldCase<T> {
  readonly wire: unknown
  readonly expected: T | undefined
  readonly label: string
}

/** A string field: only a non-empty string is a value; everything else is unknown. */
function stringField(rng: Rng): FieldCase<string> {
  const wire = pickLoose(rng, ['GPT-4o', 'Embedding V3', '', undefined, null, 42, {}, []] as const)
  return {
    wire,
    expected: typeof wire === 'string' && wire.length > 0 ? wire : undefined,
    label: `string ${JSON.stringify(wire) ?? 'undefined'}`,
  }
}

/** A capacity field: only a positive safe integer can serve as a capacity. */
function capacityField(rng: Rng): FieldCase<number> {
  const wire = pickLoose(rng, [
    128_000, 1, 16_384, 0, -1, -128_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2, '128000', undefined, null, true, {},
  ] as const)
  return {
    wire,
    expected: typeof wire === 'number' && Number.isSafeInteger(wire) && wire > 0 ? wire : undefined,
    label: `capacity ${JSON.stringify(wire) ?? 'undefined'}`,
  }
}

/** A tri-state boolean: `true`, `false`, or anything else meaning unknown. */
function booleanField(rng: Rng): FieldCase<boolean> {
  const wire = pickLoose(rng, [true, false, undefined, null, 'true', 'false', 1, 0, {}] as const)
  return {
    wire,
    expected: typeof wire === 'boolean' ? wire : undefined,
    label: `boolean ${JSON.stringify(wire) ?? 'undefined'}`,
  }
}

/** Assemble an object, omitting the keys whose generated wire value was `undefined`. */
function withDefined(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

describe('Feature: github-copilot-provider, Property 29: Dịch metadata không bịa trường nào endpoint không cung cấp', () => {
  it('carries exactly the generation fields the entry supplied, and no others', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 3_000)
      const id = `model-${String(seed)}`
      const name = stringField(rng)
      const contextWindow = capacityField(rng)
      const maxTokens = capacityField(rng)
      // The vision signal arrives from either of two places; either one alone is
      // enough, and `false` in one place does not cancel `true` in the other.
      const topVision = pickLoose(rng, [true, false, undefined, null, 'true', 1] as const)
      const supportsVision = pickLoose(rng, [true, false, undefined, null, 'yes', 0] as const)
      const responses = booleanField(rng)
      const trace = `seed ${String(seed)} ${name.label} ${contextWindow.label} `
        + `${maxTokens.label} vision ${String(topVision)}/${String(supportsVision)} ${responses.label}`

      const supports = withDefined({ vision: supportsVision, responses: responses.wire, streaming: true })
      const entry = withDefined({
        id,
        name: name.wire,
        vision: topVision,
        capabilities: {
          type: 'chat',
          family: 'family-x',
          limits: withDefined({
            max_context_window_tokens: contextWindow.wire,
            max_output_tokens: maxTokens.wire,
            max_prompt_tokens: 4_096,
          }),
          supports,
        },
      })

      const snapshot = partitionCopilotCatalog({ data: [entry] }, 8)
      const translated = snapshot.generation[0]
      expect(translated, trace).toBeDefined()
      if (translated === undefined) continue

      const visionClaimed = topVision === true || supportsVision === true
      const expectedModel = withDefined({
        id,
        name: name.expected,
        contextWindow: contextWindow.expected,
        maxTokens: maxTokens.expected,
        inputModalities: visionClaimed ? ['text', 'image'] : undefined,
      })

      // An exact object comparison, not a field-by-field one: the property is about
      // the fields that must NOT be there as much as the ones that must.
      expect(translated.model, trace).toEqual(expectedModel)
      expect(Object.keys(translated.model).sort(), trace).toEqual(Object.keys(expectedModel).sort())

      // The trap, stated on its own so a regression names itself: no vision signal
      // means the key is ABSENT. `['text']` is a negative claim about image input
      // that the endpoint never made.
      if (!visionClaimed) {
        expect(Object.keys(translated.model), `${trace}: inputModalities invented`)
          .not.toContain('inputModalities')
        expect(translated.model.inputModalities, trace).toBeUndefined()
      }

      // `undefined` is UNKNOWN, and a different state from "not supported".
      const expectedEndpoint = responses.expected === undefined
        ? undefined
        : responses.expected ? 'responses' : 'chat-completions'
      expect(translated.declaredEndpoint, trace).toBe(expectedEndpoint)

      // Nothing from the wire that this layer has no field for leaks through:
      // `family`, `tokenizer`, `max_prompt_tokens`, `streaming` are all absent.
      for (const key of ['family', 'tokenizer', 'max_prompt_tokens', 'streaming', 'description', 'outputModalities']) {
        expect(Object.keys(translated.model), `${trace}: leaked ${key}`).not.toContain(key)
      }
    }
  })

  it('carries exactly the embedding fields the entry supplied, and no others', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 4_000)
      const id = `embed-${String(seed)}`
      const name = stringField(rng)
      const family = stringField(rng)
      const maxInputTokens = capacityField(rng)
      const maxInputs = capacityField(rng)
      const dimensions = booleanField(rng)
      const trace = `seed ${String(seed)} ${name.label} ${family.label} `
        + `${maxInputTokens.label} ${maxInputs.label} ${dimensions.label}`

      const entry = withDefined({
        id,
        name: name.wire,
        capabilities: {
          type: 'embeddings',
          ...(family.wire === undefined ? {} : { family: family.wire }),
          limits: withDefined({
            max_context_window_tokens: maxInputTokens.wire,
            max_inputs: maxInputs.wire,
          }),
          supports: withDefined({ dimensions: dimensions.wire }),
        },
      })

      const snapshot = partitionCopilotCatalog({ data: [entry] }, 8)
      const translated = snapshot.embedding[0]
      expect(translated, trace).toBeDefined()
      if (translated === undefined) continue

      const expected = withDefined({
        id,
        name: name.expected,
        family: family.expected,
        maxInputTokens: maxInputTokens.expected,
        maxInputs: maxInputs.expected,
        supportsDimensions: dimensions.expected,
      })
      expect(translated, trace).toEqual(expected)
      expect(Object.keys(translated).sort(), trace).toEqual(Object.keys(expected).sort())
    }
  })
})

// ---------------------------------------------------------------------------
// Property 30
//
// "The request is still dispatched" has two halves. The half this module owns —
// an omitted entry produces DATA and never a failure, and a discovery that could
// not be read produces an empty catalog rather than an error — is asserted here in
// full. The half that lives in the dispatch path, that a request naming an omitted
// or entirely unknown id goes out and the endpoint's own error comes back
// untouched, needs the router and the adapter (tasks 8.1 and 9.1); what is
// assertable today is that the HTTP door itself is id-blind and passes a non-2xx
// response through with its body intact, which is asserted below.
// ---------------------------------------------------------------------------

describe('Feature: github-copilot-provider, Property 30: Catalog là advisory', () => {
  it('never turns an omitted entry into a failure, however many there are', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 5_000)
      const trace = `seed ${String(seed)}`
      // An all-omitted catalog is the strongest form: if omission could fail
      // anything, a catalog of nothing usable is where it would.
      const cases = Array.from({ length: 1 + intBelow(rng, 10) }, (_unused, index) => {
        const entry = buildEntryCase(rng, index)
        return entry.classification.kind === 'omitted'
          ? entry
          : { ...entry, entry: { id: entry.id, capabilities: { type: pick(rng, UNRECOGNIZED_TYPES as readonly string[]) } },
              classification: { kind: 'omitted' as const, id: entry.id, reason: 'capability-type-unrecognized' as const } }
      })

      const snapshot = partitionCopilotCatalog({ data: cases.map(c => c.entry) }, 64)
      expect(snapshot.generation, trace).toEqual([])
      expect(snapshot.embedding, trace).toEqual([])
      expect(snapshot.omitted.length, trace).toBe(cases.length)
      // Advisory means reportable, not fatal: every omission carries a reason an
      // operator can act on, and the snapshot is still a usable answer.
      for (const omitted of snapshot.omitted) {
        expect(['model-id-missing', 'capability-type-unrecognized'], trace).toContain(omitted.reason)
      }
    }
  })

  it('answers an empty catalog for every non-2xx discovery status, without an SDK error', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 6_000)
      const status = pick(rng, [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504] as const)
      // Whatever the endpoint says in the body, the catalog is not the place that
      // interprets it: the operation's own request will get the real error.
      const body = pick(rng, [
        '{"error":{"message":"no access"}}', 'not json at all', '', '{"data":"not an array"}',
      ] as const)
      const trace = `seed ${String(seed)} status ${String(status)}`
      const double = fetchDouble(() => ({ status, body }))

      const snapshot = await discoverCopilotModels(discoveryContext(), LIMITS, double.fetch)
      expect(snapshot, trace).toEqual({ generation: [], embedding: [], omitted: [] })
      expect(double.dispatched, trace).toEqual([{ url: CATALOG_URL, method: 'GET' }])
    }
  })

  it('lets the endpoint keep the last word: a non-2xx generation response passes through intact', async () => {
    // The dispatch path is id-blind, so a request naming an omitted id is dispatched
    // exactly like any other and the endpoint's own answer survives. Asserted at the
    // HTTP door because the router and adapter that choose the path do not exist yet.
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 7_000)
      const status = pick(rng, [400, 401, 404, 429, 500] as const)
      const modelId = pick(rng, [
        'code-davinci-002', 'copilot-audio-preview', 'never-in-any-catalog', '',
      ] as const)
      const body = JSON.stringify({ error: { message: `unknown model ${modelId}`, code: 'model_not_found' } })
      const trace = `seed ${String(seed)} status ${String(status)} model ${modelId}`
      const pinned = issuerOf('baseUrl', COPILOT_BASE_URL, COPILOT_BASE_URL)
      const url = copilotUrl(pinned, '/chat/completions')
      const double = fetchDouble(() => ({ status, body }))

      const response = await copilotFetch(
        { pinned, url, operation: 'chat completions', init: { method: 'POST', body: JSON.stringify({ model: modelId }) } },
        { fetch: double.fetch, requestTimeoutMs: 5_000 },
      )

      // Dispatched, not pre-empted by a catalog lookup — and the endpoint's status
      // and body arrive unchanged rather than replaced by an SDK-generated error.
      expect(double.dispatched, trace).toEqual([{ url, method: 'POST' }])
      expect(response.status, trace).toBe(status)
      expect(await response.text(), trace).toBe(body)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 31
// ---------------------------------------------------------------------------

/** A body that is wrong at the STRUCTURAL level, with the reason it is wrong. */
interface MalformedCase {
  readonly text: string
  readonly label: string
  readonly maxModels: number
}

function buildMalformedCase(rng: Rng, seed: number): MalformedCase {
  const entry = (index: number): unknown => ({ id: `model-${String(index)}`, capabilities: { type: 'chat' } })
  switch (pick(rng, ['not-json', 'root-not-object', 'data-not-array', 'too-many'] as const)) {
    case 'not-json': {
      const text = pick(rng, [
        '', ' ', 'not json at all', '{"data":[', '{"data":[]', '<html>503</html>',
        '{data:[]}', "{'data':[]}", '{"data":[],}', 'undefined',
      ] as const)
      return { text, label: `not json ${JSON.stringify(text)}`, maxModels: 8 }
    }
    case 'root-not-object': {
      // An array at the root is the shape a reasonable implementation is most
      // likely to accept by accident, and it is still not a catalog.
      const root = pickLoose(rng, [
        [], [entry(0)], 'gpt-4o', 42, true, false, null,
      ] as const)
      return { text: JSON.stringify(root), label: `root ${JSON.stringify(root) ?? 'null'}`, maxModels: 8 }
    }
    case 'data-not-array': {
      const data = pickLoose(rng, [
        undefined, null, 42, 'gpt-4o', true, { 'gpt-4o': entry(0) }, {},
      ] as const)
      return {
        text: JSON.stringify(withDefined({ object: 'list', data })),
        label: `data ${JSON.stringify(data) ?? 'absent'}`,
        maxModels: 8,
      }
    }
    default: {
      const maxModels = 1 + intBelow(rng, 5)
      const count = maxModels + 1 + intBelow(rng, 5)
      return {
        text: JSON.stringify({
          object: 'list',
          data: Array.from({ length: count }, (_unused, index) => entry(index)),
        }),
        label: `${String(count)} entries over a ${String(maxModels)} limit (seed ${String(seed)})`,
        maxModels,
      }
    }
  }
}

describe('Feature: github-copilot-provider, Property 31: Catalog sai shape là lỗi, không phải cơ sở suy diễn', () => {
  it('fails discovery with COPILOT_CATALOG_MALFORMED and yields no inferred list', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 8_000)
      const testCase = buildMalformedCase(rng, seed)
      const trace = `seed ${String(seed)} ${testCase.label}`
      const limits = resolveCopilotCatalogLimits({ maxCatalogModels: testCase.maxModels })
      const double = fetchDouble(() => ({ body: testCase.text }))

      const failure = await caught(() =>
        discoverCopilotModels(discoveryContext(), limits, double.fetch))

      // An error, not a snapshot: a model list inferred from a body this SDK could
      // not read is a list nobody can be held to.
      expect(failure, `${trace}: expected a structured error`).toBeDefined()
      expect(errorOf(failure).code, trace).toBe(COPILOT_ERROR_CODES.CATALOG_MALFORMED)
      // The request did go out — the failure is about the answer, not the call.
      expect(double.dispatched, trace).toEqual([{ url: CATALOG_URL, method: 'GET' }])
    }
  })

  it('fails the pure partition the same way, for the two shapes it can see', () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = rngOf(seed + 9_000)
      let testCase = buildMalformedCase(rng, seed)
      // `not-json` and `root-not-object` are decided before the partition is called,
      // so the pure function is exercised on the two shapes that reach it.
      while (testCase.label.startsWith('not json') || testCase.label.startsWith('root ')) {
        testCase = buildMalformedCase(rng, seed)
      }
      const trace = `seed ${String(seed)} ${testCase.label}`
      const body = JSON.parse(testCase.text) as Record<string, unknown>

      let thrown: unknown
      try {
        partitionCopilotCatalog(body, testCase.maxModels)
      } catch (error: unknown) {
        thrown = error
      }
      expect(errorOf(thrown).code, trace).toBe(COPILOT_ERROR_CODES.CATALOG_MALFORMED)
    }
  })

  it('rejects each negative fixture on its own, and keeps the positive ones readable', async () => {
    // Three separate fixtures rather than one: a regression in one shape must not
    // hide behind another (Requirement 16.3).
    for (const name of ['models-not-object.json', 'models-data-not-array.json']) {
      const { snapshot, error, dispatched } = await discoverFixture(name)
      expect(snapshot, name).toBeUndefined()
      expect(errorOf(error).code, name).toBe(COPILOT_ERROR_CODES.CATALOG_MALFORMED)
      expect(dispatched, name).toEqual([{ url: CATALOG_URL, method: 'GET' }])
    }

    // models-too-many.json carries 12 entries; it is malformed only relative to a
    // limit below that, and perfectly readable above it. The same bytes, two
    // answers, which is what makes the limit a limit and not a shape rule.
    const tight = await discoverFixture(
      'models-too-many.json', resolveCopilotCatalogLimits({ maxCatalogModels: 11 }))
    expect(errorOf(tight.error).code).toBe(COPILOT_ERROR_CODES.CATALOG_MALFORMED)
    expect(tight.snapshot).toBeUndefined()

    const roomy = await discoverFixture(
      'models-too-many.json', resolveCopilotCatalogLimits({ maxCatalogModels: 12 }))
    expect(roomy.error).toBeUndefined()
    expect(roomy.snapshot?.generation).toHaveLength(12)
    expect(roomy.snapshot?.omitted).toEqual([])
  })
})
