/**
 * Property tests for `Gemini_Embedding_Adapter`.
 *
 * Feature: embedding-support — Properties 14, 18, 19, 20, 21, 22, 23, 39, 40,
 * 41, 42, 43.
 *
 * **Validates: Requirements 6.4, 7.3, 8.1, 8.2, 8.3, 8.4, 9.3, 9.4, 9.5, 9.8,
 * 14.5, 14.6, 14.7, 14.8, 16.2**
 *
 * The same property set the OpenAI adapter answers, read with Gemini's
 * semantics. Four of them mean something different here, and those differences
 * are the reason this file exists rather than a shared parametrised suite:
 *
 *  - **Property 20** has no response index to permute. `batchEmbedContents`
 *    returns `{ embeddings: [{ values }] }` positionally, so the index is
 *    assigned by the adapter from request order and the LENGTH check is what
 *    makes that sound. The property therefore asserts both halves: a length
 *    disagreement is `EMBEDDING_VECTOR_COUNT_MISMATCH`, and a matching length
 *    yields indexes that are a permutation of the batch's own item indexes.
 *  - **Property 22** covers the `l2-renormalize` step. A narrower-than-native
 *    `outputDimensionality` makes the returned vector non-unit, the profile
 *    declares the step, and the adapter performs exactly it — no slice, no pad.
 *  - **Property 39** is the absence half of usage honesty. `batchEmbedContents`
 *    reports no usage at all, so the adapter must report NO usage rather than a
 *    fabricated `0`, and the aggregate over its batches must come out as
 *    `status: 'missing'` with one `usage-unreported` warning per dispatched
 *    batch. The warning is the runtime aggregator's to emit, not the adapter's,
 *    so both sides are asserted here.
 *  - **Property 14** is checked against the real catalog: the compatibility
 *    identity names a GENERATION, so two generations of equal width are
 *    incompatible while two model ids sharing one declared identity are not.
 *
 * ## Why the file lives here and not where the task named it
 *
 * The task names `packages/provider-gemini/tests/unit/embedding.spec.ts`. No
 * runner collects that directory: `packages/provider-gemini` has no `tests/`
 * tree at all, and both the root config and the package config collect specs out
 * of the ROOT `tests/` tree (`packages/provider-gemini/vitest.config.ts` lists
 * `../../tests/unit/...` by relative path). A spec under the package would never
 * run in CI, which is the one failure mode a property test must not have. It
 * sits beside `tests/unit/provider-gemini.spec.ts` instead, and the package
 * config's `include` was extended to collect it.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency. The convention the
 * existing property specs established is a seeded mulberry32 generator: a
 * failure reproduces from the printed seed and no new dependency enters the
 * graph for test-only reasons. Each property runs `RUNS` generated cases, above
 * the spec floor of 100.
 *
 * The adapter is driven through an injected `fetch`, so every assertion is made
 * against the bytes it actually put on the wire and the bytes it actually read
 * back.
 */
import { describe, expect, it } from 'vitest'
import { MODEL_ERROR_CODES, userAgent } from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  isSpaceCompatible,
  type EmbeddingAdapter,
  type EmbeddingBatchRequest,
  type EmbeddingItem,
  type EmbeddingPurpose,
  type EmbeddingTruncation,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  GEMINI_EMBEDDING_BASE_URL,
  GEMINI_EMBEDDING_MODELS,
  geminiEmbeddingAdapter,
} from '@alvin0/ai-agent-sdk-provider-gemini'
// Both imports below are read for their literal values only — a frozen code map
// and a pure fold over plain data — so taking them from source rather than from
// the built entry cannot introduce a second copy of any live object.
import { HTTP_PROVIDER_ERROR_CODES } from '../../packages/provider-http/src/common/config.ts'
import type { EmbeddingCatalogModel } from '../../packages/provider-http/src/transport/embedding-connection.ts'
import { aggregateEmbeddingUsage } from '../../packages/core/src/composition/embedding/usage.ts'

// ---------------------------------------------------------------------------
// Seeded generation
// ---------------------------------------------------------------------------

/** Number of generated cases per property; the spec floor is 100. */
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

function intBetween(rng: Rng, low: number, highInclusive: number): number {
  return low + intBelow(rng, highInclusive - low + 1)
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const value = values[intBelow(rng, values.length)]
  if (value === undefined) throw new Error('pick out of range')
  return value
}

/** Walk a case list shuffled, so no assertion depends on enumeration order. */
function coverEvenly<T>(rng: Rng, cases: readonly T[], runs: number): T[] {
  const plan: T[] = []
  while (plan.length < runs) {
    const round = [...cases]
    for (let index = round.length - 1; index > 0; index -= 1) {
      const swap = intBelow(rng, index + 1)
      const left = round[index]
      const right = round[swap]
      if (left === undefined || right === undefined) throw new Error('shuffle out of range')
      round[index] = right
      round[swap] = left
    }
    plan.push(...round)
  }
  return plan.slice(0, runs)
}

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'επsilon', 'ζeta', '한국어', 'emoji 🙂']

function textOf(rng: Rng): string {
  return `${pick(rng, WORDS)}-${intBelow(rng, 10_000)}`
}

/** Non-zero finite values, so a renormalized vector has a direction to keep. */
function vectorOf(rng: Rng, width: number): number[] {
  const values: number[] = []
  for (let index = 0; index < width; index += 1) {
    const magnitude = 0.05 + rng() * 4
    values.push(rng() < 0.5 ? -magnitude : magnitude)
  }
  return values
}

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'private-gemini-embedding-key'
const NATIVE_WIDTH = 3072
const NARROWER_WIDTHS = [1536, 768] as const

/** Catalog spec with every capability expressed as present-or-omitted. */
interface CatalogSpec {
  readonly id?: string | undefined
  readonly dimensions?: readonly number[] | undefined
  readonly defaultDimensions?: number | undefined
  readonly maxInputTokens?: number | undefined
  readonly purposeHandling?: EmbeddingCatalogModel['purposeHandling'] | undefined
  readonly normalization?: EmbeddingCatalogModel['normalization'] | undefined
  readonly compatibilityIdentity?: string | undefined
}

/**
 * Build one catalog entry.
 *
 * Omission is meaningful here — an omitted field is an `unknown` capability, not
 * a default — so every optional field is spread conditionally rather than
 * written as an explicit `undefined`.
 */
function catalogModel(spec: CatalogSpec = {}): EmbeddingCatalogModel {
  return {
    id: spec.id ?? 'gemini-embedding-001',
    ...(spec.dimensions === undefined ? {} : { dimensions: spec.dimensions }),
    ...(spec.defaultDimensions === undefined
      ? {}
      : { defaultDimensions: spec.defaultDimensions }),
    ...(spec.maxInputTokens === undefined ? {} : { maxInputTokens: spec.maxInputTokens }),
    ...(spec.purposeHandling === undefined ? {} : { purposeHandling: spec.purposeHandling }),
    ...(spec.normalization === undefined ? {} : { normalization: spec.normalization }),
    compatibilityIdentity: spec.compatibilityIdentity ?? 'google:gemini-embedding-001',
  }
}

/** The declaration the shipped catalog makes: widths, native width, taskType. */
function declaredModel(spec: CatalogSpec = {}): EmbeddingCatalogModel {
  return catalogModel({
    dimensions: [NATIVE_WIDTH, ...NARROWER_WIDTHS],
    defaultDimensions: NATIVE_WIDTH,
    purposeHandling: { kind: 'wire-parameter', parameter: 'taskType' },
    ...spec,
  })
}

/**
 * The same declaration at a width that is cheap to assert element by element.
 *
 * The `l2-renormalize` condition is "narrower than the declared native width",
 * not "narrower than 3072", so a 16-dimensional generation exercises exactly the
 * same branch for a thousandth of the numbers.
 */
const SMALL_NATIVE_WIDTH = 16
const SMALL_NARROWER_WIDTHS = [8, 4] as const

function smallModel(spec: CatalogSpec = {}): EmbeddingCatalogModel {
  return declaredModel({
    dimensions: [SMALL_NATIVE_WIDTH, ...SMALL_NARROWER_WIDTHS],
    defaultDimensions: SMALL_NATIVE_WIDTH,
    ...spec,
  })
}

// ---------------------------------------------------------------------------
// Wire capture
// ---------------------------------------------------------------------------

/** One outbound request, decoded exactly as the transport serialized it. */
interface Capture {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: WireBody
}

interface WireRequest {
  readonly model?: unknown
  readonly content?: { readonly parts?: readonly { readonly text?: unknown }[] }
  readonly taskType?: unknown
  readonly outputDimensionality?: unknown
  readonly [key: string]: unknown
}

interface WireBody {
  readonly requests?: readonly WireRequest[]
}

/** A response body plus the media type it claims, so both can be wrong. */
interface Reply {
  readonly text: string
  readonly contentType?: string
  readonly status?: number
}

function jsonReply(payload: unknown): Reply {
  return { text: JSON.stringify(payload) }
}

interface Wire {
  readonly fetch: typeof globalThis.fetch
  readonly captures: readonly Capture[]
}

function wireOf(reply: (capture: Capture, callIndex: number) => Reply): Wire {
  const captures: Capture[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const capture: Capture = {
      url: String(input),
      headers: Object.freeze(headers),
      body: JSON.parse(String(init?.body ?? 'null')) as WireBody,
    }
    captures.push(capture)
    const chosen = reply(capture, captures.length - 1)
    return new Response(chosen.text, {
      status: chosen.status ?? 200,
      headers: { 'content-type': chosen.contentType ?? 'application/json' },
    })
  }
  return { fetch, captures }
}

/** Read the requests array, failing loudly rather than asserting on `undefined`. */
function wireRequests(capture: Capture): readonly WireRequest[] {
  const requests = capture.body.requests
  if (!Array.isArray(requests)) throw new Error('wire body carried no requests array')
  return requests
}

function requestAt(capture: Capture, position: number): WireRequest {
  const request = wireRequests(capture)[position]
  if (request === undefined) throw new Error(`wire body carried no request at ${position}`)
  return request
}

function firstCapture(wire: Wire): Capture {
  const capture = wire.captures[0]
  if (capture === undefined) throw new Error('adapter sent no request')
  return capture
}

// ---------------------------------------------------------------------------
// Adapter and batch construction
// ---------------------------------------------------------------------------

interface AdapterSpec {
  readonly fetch: typeof globalThis.fetch
  readonly models?: readonly EmbeddingCatalogModel[]
  readonly baseUrl?: string
  readonly allowInsecureHttp?: boolean
}

function adapterOf(spec: AdapterSpec): EmbeddingAdapter {
  return geminiEmbeddingAdapter({
    apiKey: API_KEY,
    fetch: spec.fetch,
    ...(spec.models === undefined ? {} : { models: spec.models }),
    ...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
    ...(spec.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: spec.allowInsecureHttp }),
  })
}

interface BatchSpec {
  readonly items: readonly EmbeddingItem[]
  readonly purpose?: EmbeddingPurpose
  readonly dimensions?: number
  readonly truncation?: EmbeddingTruncation
  readonly model?: string
}

function batchOf(spec: BatchSpec): EmbeddingBatchRequest {
  return {
    provider: 'gemini-embedding',
    model: spec.model ?? 'gemini-embedding-001',
    purpose: spec.purpose ?? 'retrieval-document',
    items: spec.items,
    ...(spec.dimensions === undefined ? {} : { dimensions: spec.dimensions }),
    truncation: spec.truncation ?? 'reject',
  }
}

/**
 * Items with a deliberate index offset.
 *
 * Indexes are `Logical_Call` numbering, so an item's index is NOT its position
 * in the batch. Offsetting them is what makes positional mapping observable.
 */
function itemsOf(rng: Rng, count: number, offset: number, partsPerItem = 1): EmbeddingItem[] {
  const items: EmbeddingItem[] = []
  for (let position = 0; position < count; position += 1) {
    const parts: { readonly type: 'text'; readonly text: string }[] = []
    for (let part = 0; part < partsPerItem; part += 1) {
      parts.push({ type: 'text', text: textOf(rng) })
    }
    items.push({ index: offset + position, contentParts: parts })
  }
  return items
}

/** Every item's text, in content-part order, as the wire should carry it. */
function partTexts(item: EmbeddingItem): readonly string[] {
  return item.contentParts.map(part => part.text)
}

function embeddingsPayload(vectors: readonly (readonly number[])[]): unknown {
  return { embeddings: vectors.map(values => ({ values })) }
}

function l2(values: readonly number[]): number {
  let sum = 0
  for (const value of values) sum += value * value
  return Math.sqrt(sum)
}

/** The code carried by a thrown error, or a marker that says there was none. */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'string') return code
  }
  return `no-code:${String(error)}`
}

async function failureOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the adapter to reject, but it resolved')
}

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 18: Purpose được dịch ở adapter, không rò rỉ prefix không tài liệu', () => {
  /** Every purpose-handling declaration a route can make, and what it implies. */
  const HANDLING: readonly {
    readonly label: string
    readonly declaration: EmbeddingCatalogModel['purposeHandling']
    readonly parameter?: string
  }[] = [
    {
      label: 'declared wire parameter',
      declaration: { kind: 'wire-parameter', parameter: 'taskType' },
      parameter: 'taskType',
    },
    {
      label: 'declared wire parameter under another name',
      declaration: { kind: 'wire-parameter', parameter: 'task_type' },
      parameter: 'task_type',
    },
    { label: 'declared unsupported', declaration: 'unsupported' },
    { label: 'undeclared', declaration: undefined },
  ]

  const PURPOSES: readonly { readonly purpose: EmbeddingPurpose; readonly taskType: string }[] = [
    { purpose: 'retrieval-query', taskType: 'RETRIEVAL_QUERY' },
    { purpose: 'retrieval-document', taskType: 'RETRIEVAL_DOCUMENT' },
  ]

  it('spells purpose only through a declared parameter and sends the text verbatim', async () => {
    const rng = rngOf(0x18_0001)
    const plan = coverEvenly(
      rng,
      HANDLING.flatMap(handling => PURPOSES.map(purpose => ({ handling, purpose }))),
      RUNS,
    )
    for (const [run, { handling, purpose }] of plan.entries()) {
      const seed = `run ${run} / ${handling.label} / ${purpose.purpose}`
      const model = declaredModel(
        handling.declaration === undefined
          ? { purposeHandling: undefined }
          : { purposeHandling: handling.declaration },
      )
      const items = itemsOf(rng, intBetween(rng, 1, 3), intBelow(rng, 20), intBetween(rng, 1, 3))
      const wire = wireOf(() => jsonReply(
        embeddingsPayload(items.map(() => vectorOf(rng, 4))),
      ))
      await adapterOf({ fetch: wire.fetch, models: [model] })
        .embedBatch(batchOf({ items, purpose: purpose.purpose }))
      const capture = firstCapture(wire)
      for (const [position, item] of items.entries()) {
        const request = requestAt(capture, position)
        // Verbatim: the exact strings the caller supplied, part for part. No
        // prefix, no suffix, no reordering, no joining.
        expect(request.content?.parts, seed).toEqual(
          partTexts(item).map(text => ({ text })),
        )
        if (handling.parameter === undefined) {
          // Nothing declared a mechanism, so no parameter may be invented — and
          // no OTHER key may carry the vocabulary either.
          expect(Object.keys(request), seed).not.toContain('taskType')
          expect(Object.values(request).map(String), seed)
            .not.toContain(purpose.taskType)
        } else {
          expect(request[handling.parameter], seed).toBe(purpose.taskType)
        }
      }
      // The purpose vocabulary never reaches the input text itself.
      const encoded = JSON.stringify(capture.body.requests?.map(request => request.content))
      expect(encoded, seed).not.toContain('RETRIEVAL_')
      expect(encoded, seed).not.toContain('query:')
    }
  })
})

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 19: N input độc lập cho đúng N vector mang chỉ số gốc', () => {
  it('returns one vector per input, carrying the logical-call index', async () => {
    const rng = rngOf(0x19_0002)
    for (let run = 0; run < RUNS; run += 1) {
      const seed = `run ${run}`
      const count = intBetween(rng, 1, 8)
      const offset = intBelow(rng, 50)
      const items = itemsOf(rng, count, offset, intBetween(rng, 1, 2))
      const returned = items.map(() => vectorOf(rng, intBetween(rng, 2, 6)))
      const wire = wireOf(() => jsonReply(embeddingsPayload(returned)))
      const result = await adapterOf({ fetch: wire.fetch, models: [declaredModel()] })
        .embedBatch(batchOf({ items }))
      expect(result.vectors.length, seed).toBe(count)
      // One request element per item, so no item was merged into another.
      expect(wireRequests(firstCapture(wire)).length, seed).toBe(count)
      for (const [position, item] of items.entries()) {
        const vector = result.vectors[position]
        expect(vector?.index, seed).toBe(item.index)
        expect(vector?.values, seed).toEqual(returned[position])
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 20: Tập chỉ số response phải là một permutation hợp lệ', () => {
  it('assigns a permutation positionally, and refuses any length disagreement', async () => {
    const rng = rngOf(0x20_0003)
    // Gemini sends no index, so the failure mode is a length disagreement: the
    // deltas below cover short, long and empty responses.
    const DELTAS = [-2, -1, 0, 1, 3] as const
    const plan = coverEvenly(rng, DELTAS, RUNS)
    for (const [run, delta] of plan.entries()) {
      const seed = `run ${run} / delta ${delta}`
      const count = intBetween(rng, 2, 6)
      const items = itemsOf(rng, count, intBelow(rng, 30))
      const returnedCount = Math.max(0, count + delta)
      const returned: number[][] = []
      for (let index = 0; index < returnedCount; index += 1) returned.push(vectorOf(rng, 3))
      const wire = wireOf(() => jsonReply(embeddingsPayload(returned)))
      const adapter = adapterOf({ fetch: wire.fetch, models: [declaredModel()] })
      const batch = batchOf({ items })
      if (delta === 0) {
        const result = await adapter.embedBatch(batch)
        const indexes = result.vectors.map(vector => vector.index)
        // A bijection onto the batch's own item indexes: no duplicate, no gap,
        // nothing out of range.
        expect([...indexes].sort((a, b) => a - b), seed)
          .toEqual(items.map(item => item.index).sort((a, b) => a - b))
        expect(new Set(indexes).size, seed).toBe(count)
        continue
      }
      const error = await failureOf(() => adapter.embedBatch(batch))
      expect(codeOf(error), seed).toBe(EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 21: Vector không hợp lệ là lỗi, không phải dữ liệu để sửa', () => {
  /** Each defect and the code it must produce; none of them is repairable. */
  const DEFECTS: readonly {
    readonly label: string
    readonly code: string
    readonly damage: (values: number[], requested: number) => unknown
  }[] = [
    { label: 'NaN', code: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID, damage: values => ({ values: [...values.slice(1), Number.NaN] }) },
    { label: 'Infinity', code: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID, damage: values => ({ values: [Number.POSITIVE_INFINITY, ...values.slice(1)] }) },
    { label: '-Infinity', code: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID, damage: values => ({ values: [Number.NEGATIVE_INFINITY, ...values.slice(1)] }) },
    { label: 'string value', code: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID, damage: values => ({ values: [...values.slice(1), '0.5'] }) },
    { label: 'null value', code: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID, damage: values => ({ values: [null, ...values.slice(1)] }) },
    { label: 'values absent', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, damage: () => ({ embedding: [0.1, 0.2] }) },
    { label: 'values not an array', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, damage: () => ({ values: 'nope' }) },
    { label: 'narrower than requested', code: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH, damage: (values, requested) => ({ values: values.slice(0, requested - 1) }) },
    { label: 'wider than requested', code: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH, damage: (values, requested) => ({ values: [...values, 0.25, 0.5].slice(0, requested + 1) }) },
  ]

  it('raises the declared code and returns nothing when a vector is unusable', async () => {
    const rng = rngOf(0x21_0004)
    const plan = coverEvenly(rng, DEFECTS, RUNS)
    for (const [run, defect] of plan.entries()) {
      const seed = `run ${run} / ${defect.label}`
      const requested = SMALL_NATIVE_WIDTH
      const count = intBetween(rng, 1, 4)
      const items = itemsOf(rng, count, intBelow(rng, 12))
      const damagedPosition = intBelow(rng, count)
      const wire = wireOf(() => jsonReply({
        embeddings: items.map((_item, position) => position === damagedPosition
          ? defect.damage(vectorOf(rng, requested), requested)
          : { values: vectorOf(rng, requested) }),
      }))
      const error = await failureOf(() => adapterOf({
        fetch: wire.fetch,
        models: [smallModel()],
      }).embedBatch(batchOf({ items, dimensions: requested })))
      expect(codeOf(error), seed).toBe(defect.code)
      // The request went out exactly once: the defect is a response fault, and
      // the adapter does not retry or re-ask to obtain a usable value.
      expect(wire.captures.length, seed).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 22: Vector trả ra trung thực với vector provider trả về', () => {
  it('passes values through untouched, or applies exactly the declared l2-renormalize', async () => {
    const rng = rngOf(0x22_0005)
    /** Native and undeclared widths carry no step; a narrower width carries one. */
    const CASES = [
      { label: 'no width requested', requested: undefined, step: false },
      { label: 'native width requested', requested: SMALL_NATIVE_WIDTH, step: false },
      { label: 'narrower width 8', requested: 8, step: true },
      { label: 'narrower width 4', requested: 4, step: true },
    ] as const
    const plan = coverEvenly(rng, CASES, RUNS)
    for (const [run, testCase] of plan.entries()) {
      const seed = `run ${run} / ${testCase.label}`
      const width = testCase.requested ?? SMALL_NATIVE_WIDTH
      const count = intBetween(rng, 1, 4)
      const items = itemsOf(rng, count, intBelow(rng, 10))
      // With no requested width the provider's own width stands unchallenged,
      // which is itself part of the faithfulness claim.
      const returned = items.map(() => vectorOf(rng, testCase.requested === undefined ? 5 : width))
      const wire = wireOf(() => jsonReply(embeddingsPayload(returned)))
      const result = await adapterOf({ fetch: wire.fetch, models: [smallModel()] })
        .embedBatch(batchOf({
          items,
          ...(testCase.requested === undefined ? {} : { dimensions: testCase.requested }),
        }))
      for (const [position, source] of returned.entries()) {
        const values = result.vectors[position]?.values
        expect(values?.length, seed).toBe(source.length)
        if (!testCase.step) {
          // Element-for-element identical: nothing was scaled, rounded, sliced
          // or padded on the way out.
          expect(values, seed).toEqual(source)
          continue
        }
        const norm = l2(source)
        expect(l2(values ?? []), seed).toBeCloseTo(1, 10)
        // Direction preserved: every component keeps its sign and its ratio.
        for (const [component, value] of source.entries()) {
          expect(values?.[component], `${seed} / component ${component}`)
            .toBeCloseTo(value / norm, 10)
        }
      }
    }
  })

  it('passes a zero vector through rather than dividing by zero', async () => {
    const items = itemsOf(rngOf(0x22_0006), 2, 4)
    const zeros = items.map(() => Array.from({ length: 8 }, () => 0))
    const wire = wireOf(() => jsonReply(embeddingsPayload(zeros)))
    const result = await adapterOf({ fetch: wire.fetch, models: [smallModel()] })
      .embedBatch(batchOf({ items, dimensions: 8 }))
    for (const vector of result.vectors) {
      expect(vector.values.every(value => value === 0)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 23: Truncation chỉ khi được bật, và luôn có warning', () => {
  it('refuses truncation before dispatch, and never claims a truncation it did not observe', async () => {
    const rng = rngOf(0x23_0007)
    const plan = coverEvenly(rng, ['reject', 'allow'] as const, RUNS)
    for (const [run, truncation] of plan.entries()) {
      const seed = `run ${run} / ${truncation}`
      const items = itemsOf(rng, intBetween(rng, 1, 4), intBelow(rng, 10))
      const wire = wireOf(() => jsonReply(
        embeddingsPayload(items.map(() => vectorOf(rng, 4))),
      ))
      const adapter = adapterOf({ fetch: wire.fetch, models: [declaredModel()] })
      const batch = batchOf({ items, truncation })
      if (truncation === 'allow') {
        const error = await failureOf(() => adapter.embedBatch(batch))
        expect(codeOf(error), seed).toBe(EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED)
        // Refused at the adapter boundary: no `Provider_Attempt` was spent on a
        // behaviour the endpoint cannot express.
        expect(wire.captures.length, seed).toBe(0)
        continue
      }
      const result = await adapter.embedBatch(batch)
      expect(wire.captures.length, seed).toBe(1)
      // Nothing was truncated, so nothing is flagged as truncated and no
      // truncation warning is fabricated.
      expect(result.vectors.some(vector => vector.truncated === true), seed).toBe(false)
      expect(result.warnings?.some(warning => warning.code === 'input-truncated') ?? false, seed)
        .toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 40: Dimensions chỉ lên wire khi route khai báo hỗ trợ', () => {
  it('sends outputDimensionality only for a route that declares selectable widths', async () => {
    const rng = rngOf(0x40_0008)
    const CASES = [
      { label: 'declared widths, width requested', declared: true, requested: true },
      { label: 'declared widths, no width requested', declared: true, requested: false },
      { label: 'undeclared widths, width requested', declared: false, requested: true },
      { label: 'undeclared widths, no width requested', declared: false, requested: false },
    ] as const
    const plan = coverEvenly(rng, CASES, RUNS)
    for (const [run, testCase] of plan.entries()) {
      const seed = `run ${run} / ${testCase.label}`
      const width = pick(rng, SMALL_NARROWER_WIDTHS)
      const model = testCase.declared
        ? smallModel()
        // No `dimensions` and no `defaultDimensions`: the route claims nothing
        // about width, so nothing about width may be sent or post-processed.
        : catalogModel({ purposeHandling: { kind: 'wire-parameter', parameter: 'taskType' } })
      const items = itemsOf(rng, intBetween(rng, 1, 3), intBelow(rng, 10))
      const returnedWidth = testCase.requested ? width : 6
      const wire = wireOf(() => jsonReply(
        embeddingsPayload(items.map(() => vectorOf(rng, returnedWidth))),
      ))
      await adapterOf({ fetch: wire.fetch, models: [model] }).embedBatch(batchOf({
        items,
        ...(testCase.requested ? { dimensions: width } : {}),
      }))
      const capture = firstCapture(wire)
      for (let position = 0; position < items.length; position += 1) {
        const request = requestAt(capture, position)
        if (testCase.declared && testCase.requested) {
          expect(request.outputDimensionality, seed).toBe(width)
        } else {
          expect(Object.keys(request), seed).not.toContain('outputDimensionality')
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 41
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 41: Attribution headers trên mọi request embedding', () => {
  it('carries attribution, JSON negotiation and the credential on every batch', async () => {
    const rng = rngOf(0x41_0009)
    const expectedAgent = userAgent()
    for (let run = 0; run < RUNS; run += 1) {
      const seed = `run ${run}`
      const batches = intBetween(rng, 1, 3)
      const wire = wireOf(capture => jsonReply(
        embeddingsPayload(wireRequests(capture).map(() => vectorOf(rng, 3))),
      ))
      const adapter = adapterOf({ fetch: wire.fetch, models: [declaredModel()] })
      for (let batch = 0; batch < batches; batch += 1) {
        await adapter.embedBatch(batchOf({
          items: itemsOf(rng, intBetween(rng, 1, 3), batch * 10),
        }))
      }
      expect(wire.captures.length, seed).toBe(batches)
      for (const capture of wire.captures) {
        expect(capture.headers['user-agent'], seed).toBe(expectedAgent)
        expect(capture.headers['content-type'], seed).toBe('application/json')
        expect(capture.headers['accept'], seed).toBe('application/json')
        // The auth layer sits on top of attribution, so neither erases the other.
        expect(capture.headers['x-goog-api-key'], seed).toBe(API_KEY)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Property 42
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 42: baseUrl được tôn trọng và cleartext HTTP cần bật tường minh', () => {
  it('honours a configured base and refuses cleartext unless it was enabled', async () => {
    const rng = rngOf(0x42_000a)
    const CASES = [
      { label: 'default base', base: undefined, insecure: undefined, sends: true },
      { label: 'custom https base', base: 'https://embeddings.internal/v1beta', insecure: undefined, sends: true },
      { label: 'custom https base with trailing slash', base: 'https://embeddings.internal/v1beta/', insecure: undefined, sends: true },
      { label: 'cleartext, not enabled', base: 'http://localhost:8099/v1beta', insecure: undefined, sends: false },
      { label: 'cleartext, explicitly refused', base: 'http://localhost:8099/v1beta', insecure: false, sends: false },
      { label: 'cleartext, explicitly enabled', base: 'http://localhost:8099/v1beta', insecure: true, sends: true },
    ] as const
    const plan = coverEvenly(rng, CASES, RUNS)
    for (const [run, testCase] of plan.entries()) {
      const seed = `run ${run} / ${testCase.label}`
      const items = itemsOf(rng, intBetween(rng, 1, 3), intBelow(rng, 8))
      // Half the runs address the model by its `models/`-prefixed resource name,
      // which must not double the prefix in the path.
      const prefixed = rng() < 0.5
      const wire = wireOf(() => jsonReply(
        embeddingsPayload(items.map(() => vectorOf(rng, 3))),
      ))
      const adapter = adapterOf({
        fetch: wire.fetch,
        models: [declaredModel()],
        ...(testCase.base === undefined ? {} : { baseUrl: testCase.base }),
        ...(testCase.insecure === undefined ? {} : { allowInsecureHttp: testCase.insecure }),
      })
      const batch = batchOf({
        items,
        ...(prefixed ? { model: 'models/gemini-embedding-001' } : {}),
      })
      const expectedBase = (testCase.base ?? GEMINI_EMBEDDING_BASE_URL).replace(/\/+$/, '')
      if (!testCase.sends) {
        const error = await failureOf(() => adapter.embedBatch(batch))
        expect(codeOf(error), seed).toBe(MODEL_ERROR_CODES.INVALID_REQUEST)
        // Refused before the socket: a cleartext endpoint never sees the key.
        expect(wire.captures.length, seed).toBe(0)
        continue
      }
      await adapter.embedBatch(batch)
      expect(firstCapture(wire).url, seed)
        .toBe(`${expectedBase}/models/gemini-embedding-001:batchEmbedContents`)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 43
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 43: Response không thoả contract là protocol error, không phải cơ sở suy diễn', () => {
  it('turns every off-contract response into a code, never into a vector', async () => {
    const rng = rngOf(0x43_000b)
    /** Each off-contract response, and the code it must produce. */
    const CASES: readonly {
      readonly label: string
      readonly code: string
      readonly reply: (count: number) => Reply
    }[] = [
      { label: 'html media type', code: HTTP_PROVIDER_ERROR_CODES.JSON_MEDIA_TYPE_INVALID, reply: () => ({ text: '<html>gateway</html>', contentType: 'text/html' }) },
      { label: 'text media type', code: HTTP_PROVIDER_ERROR_CODES.JSON_MEDIA_TYPE_INVALID, reply: () => ({ text: '{"embeddings":[]}', contentType: 'text/plain' }) },
      { label: 'truncated json', code: MODEL_ERROR_CODES.MALFORMED_RESPONSE, reply: () => ({ text: '{"embeddings":[{"values":[0.1' }) },
      { label: 'json null', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: () => ({ text: 'null' }) },
      { label: 'json string', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: () => ({ text: '"ok"' }) },
      { label: 'json array', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: () => ({ text: '[]' }) },
      { label: 'embeddings absent', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: () => jsonReply({ predictions: [] }) },
      { label: 'embeddings not an array', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: () => jsonReply({ embeddings: { values: [0.1] } }) },
      { label: 'entry not an object', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: count => jsonReply({ embeddings: Array.from({ length: count }, () => 0.5) }) },
      { label: 'entry values absent', code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, reply: count => jsonReply({ embeddings: Array.from({ length: count }, () => ({ embedding: [0.5] })) }) },
      { label: 'http 500', code: MODEL_ERROR_CODES.SERVER, reply: () => ({ text: '{"error":{"message":"boom"}}', status: 500 }) },
    ]
    const plan = coverEvenly(rng, CASES, RUNS)
    for (const [run, testCase] of plan.entries()) {
      const seed = `run ${run} / ${testCase.label}`
      const items = itemsOf(rng, intBetween(rng, 1, 3), intBelow(rng, 8))
      const wire = wireOf(() => testCase.reply(items.length))
      const error = await failureOf(() => adapterOf({
        fetch: wire.fetch,
        models: [declaredModel()],
      }).embedBatch(batchOf({ items })))
      expect(codeOf(error), seed).toBe(testCase.code)
      expect(wire.captures.length, seed).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 14: Tương thích space quyết định bởi compatibility identity', () => {
  it('separates model generations of equal width, and joins ids sharing one declared identity', async () => {
    const rng = rngOf(0x14_000c)
    const wire = wireOf(() => jsonReply({ embeddings: [] }))
    for (let run = 0; run < RUNS; run += 1) {
      const seed = `run ${run}`
      const width = pick(rng, [NATIVE_WIDTH, ...NARROWER_WIDTHS])
      const generationA = `google:gemini-embedding-00${intBetween(rng, 1, 4)}`
      const generationB = `google:gemini-embedding-${intBetween(rng, 5, 9)}`
      // Same width, same everything else — only the declared generation differs.
      const first = declaredModel({ id: 'model-a', compatibilityIdentity: generationA })
      const second = declaredModel({ id: 'model-b', compatibilityIdentity: generationB })
      // A second id inside the SAME declared generation.
      const sibling = declaredModel({ id: 'model-a-mirror', compatibilityIdentity: generationA })
      const adapter = adapterOf({ fetch: wire.fetch, models: [first, second, sibling] })
      const [a, b, mirror] = await Promise.all([
        adapter.prepareEmbeddingCall('gemini-embedding', 'model-a', { dimensions: width }),
        adapter.prepareEmbeddingCall('gemini-embedding', 'model-b', { dimensions: width }),
        adapter.prepareEmbeddingCall('gemini-embedding', 'model-a-mirror', { dimensions: width }),
      ])
      expect(a.profile.dimensions, seed).toBe(b.profile.dimensions)
      // Equal width is not compatibility.
      expect(isSpaceCompatible(a.profile, b.profile), seed).toBe(false)
      expect(a.spaceId, seed).not.toBe(b.spaceId)
      // A different model NAME inside one declared generation is compatible: the
      // identity decides, not the id.
      expect(a.profile.modelIdentity, seed).not.toBe(mirror.profile.modelIdentity)
      expect(isSpaceCompatible(a.profile, mirror.profile), seed).toBe(true)
      expect(a.spaceId, seed).toBe(mirror.spaceId)
    }
  })

  it('declares a generation-specific identity in the shipped catalog', () => {
    for (const model of GEMINI_EMBEDDING_MODELS) {
      expect(model.compatibilityIdentity).toBe(`google:${model.id}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Property 39
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 39: Usage không đầy đủ không bao giờ thoát ra dưới dạng số liệu công bố', () => {
  it('reports no usage at all, and aggregates to missing with one warning per batch', async () => {
    const rng = rngOf(0x39_000d)
    for (let run = 0; run < RUNS; run += 1) {
      const seed = `run ${run}`
      const batchCount = intBetween(rng, 1, 4)
      const evidence: { itemIndexes: number[]; attempts: number; usage?: unknown }[] = []
      let nextIndex = 0
      let attemptTotal = 0
      for (let batch = 0; batch < batchCount; batch += 1) {
        const items = itemsOf(rng, intBetween(rng, 1, 3), nextIndex)
        nextIndex += items.length
        // Some runs have the endpoint volunteer usage-shaped noise; the adapter
        // reads none of it, so nothing can leak into a published total.
        const noise = rng() < 0.5
          ? { usageMetadata: { promptTokenCount: intBetween(rng, 1, 500) } }
          : {}
        const wire = wireOf(() => jsonReply({
          ...noise,
          embeddings: items.map(() => ({ values: vectorOf(rng, 3) })),
        }))
        const result = await adapterOf({ fetch: wire.fetch, models: [declaredModel()] })
          .embedBatch(batchOf({ items }))
        // Absent, not zero and not an empty object: the field is not there at all.
        expect(Object.hasOwn(result, 'usage'), seed).toBe(false)
        expect(result.usage, seed).toBeUndefined()
        const attempts = 1
        attemptTotal += attempts
        evidence.push({ itemIndexes: items.map(item => item.index), attempts })
      }
      const aggregate = aggregateEmbeddingUsage({ inputCount: nextIndex, batches: evidence })
      expect(aggregate.report.status, seed).toBe('missing')
      expect(aggregate.report.batches, seed).toBe(batchCount)
      expect(aggregate.report.batchesWithUsage, seed).toBe(0)
      // No token figure is published for a call nobody reported on.
      expect(aggregate.report.tokens, seed).toBeUndefined()
      expect(aggregate.report.providerAttempts, seed).toBe(attemptTotal)
      expect(
        aggregate.report.inputsFromCache + aggregate.report.inputsFromProvider,
        seed,
      ).toBe(nextIndex)
      // Exactly one `usage-unreported` per dispatched batch, and nothing else.
      expect(aggregate.warnings.length, seed).toBe(batchCount)
      expect(aggregate.warnings.every(warning => warning.code === 'usage-unreported'), seed)
        .toBe(true)
    }
  })
})
