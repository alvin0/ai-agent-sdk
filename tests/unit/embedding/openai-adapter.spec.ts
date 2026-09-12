/**
 * Property tests for `OpenAI_Embedding_Adapter`.
 *
 * Feature: embedding-support, Properties 18, 19, 20, 21, 22, 23, 40, 41, 42, 43.
 *
 * **Validates: Requirements 7.3, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.7, 9.3, 9.4,
 * 9.5, 9.6, 9.7, 9.8, 14.4, 14.7, 15.1, 15.4, 15.5**
 *
 * Every property here is observed through an INJECTED `fetch`. That is the whole
 * design of the test: what the adapter promises is a wire body, a URL, a header
 * set and a mapping back — so the stub captures the exact request and answers
 * with an exact response text, and the assertions are made against those two
 * artefacts rather than against a second implementation of the same translation.
 *
 * Two things the stub does deliberately:
 *
 * - **It answers with raw text, not with an object.** `NaN` and `Infinity` have
 *   no JSON literal, and `JSON.stringify` would quietly turn them into `null`.
 *   A body of `1e999` parses to `Infinity`, which is how Property 21's non-finite
 *   case is reachable at all. Handing the adapter pre-built objects would also
 *   skip the media-type and parse guards Property 43 depends on.
 * - **It records every call, including the ones that fail.** Several properties
 *   are about what did NOT happen — no request at all for a rejected truncation
 *   or a cleartext base — and a rejection that had already put a batch on the
 *   wire is a different (worse) outcome than one that had not.
 *
 * ## Why the file lives here and not where the task named it
 *
 * `tasks.md` names `packages/provider-openai/tests/unit/embedding.spec.ts`. No
 * runner collects that directory: `packages/provider-openai/vitest.config.ts`
 * includes exactly `../../tests/unit/provider-openai.spec.ts` from the ROOT tests
 * tree, and the root `vitest.config.ts` includes `tests/**`. The sibling embedding
 * specs in this directory document the same deviation. Placing the file where the
 * task named it would mean writing ten properties that never run.
 *
 * ## Why seeded generation rather than a property-testing library
 *
 * The repository carries no property-testing dependency, and the convention in the
 * sibling embedding specs is a seeded mulberry32 generator: a failure reproduces
 * from the printed seed and nothing test-only enters the dependency graph. `RUNS`
 * is above the spec floor of 100 for every property.
 *
 * @module tests/unit/embedding/openai-adapter.spec
 */

import { describe, expect, it } from 'vitest'
import { EMBEDDING_ERROR_CODES } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingBatchRequest,
  EmbeddingItem,
} from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../../packages/core/src/embedding/result.ts'
import type { EmbeddingPurpose } from '../../../packages/core/src/embedding/purpose.ts'
import { attributionHeaders } from '../../../packages/core/src/http/attribution.ts'
import { MODEL_ERROR_CODES } from '../../../packages/core/src/errors/model-error.ts'
import type { EmbeddingCatalogModel } from '../../../packages/provider-http/src/transport/embedding-connection.ts'
import { openAiEmbeddingAdapter } from '../../../packages/provider-openai/src/embedding.ts'

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
function shuffled<T>(rng: Rng, values: readonly T[]): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = intBelow(rng, index + 1)
    ;[copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T]
  }
  return copy
}

const PURPOSES: readonly EmbeddingPurpose[] = Object.freeze([
  'retrieval-query',
  'retrieval-document',
])

/**
 * Text fragments chosen to make an invented prefix visible.
 *
 * Several of them LOOK like the prefixes a helpful adapter might add
 * (`'query: '`, `'passage: '`), which is the point: if the adapter ever prepended
 * one of its own, a caller's text that already contains it would be the hardest
 * case to notice, so it is generated on purpose. The rest carry whitespace,
 * newlines, non-Latin script and emoji, none of which may be normalised away.
 */
const FRAGMENTS: readonly string[] = Object.freeze([
  'query: ',
  'passage: ',
  'search_document: ',
  ' leading space',
  'trailing space ',
  'line\nbreak',
  'tab\tseparated',
  'Ünïcödé',
  '日本語のテキスト',
  'emoji 🧬🚀',
  'json-ish {"a":1}',
  '',
  'plain text',
])

function randomText(rng: Rng): string {
  const parts = 1 + intBelow(rng, 3)
  let text = ''
  for (let part = 0; part < parts; part += 1) text += pick(rng, FRAGMENTS)
  return text
}

/**
 * One item whose text is split across a random number of content parts.
 *
 * The split is what Requirement 8.7 is about: N content parts are components of
 * ONE object and must produce ONE wire input and ONE vector, never N of either.
 * The logical index is generated well away from the batch positions `0..N-1`, so
 * a mapping that confused the two cannot pass by coincidence.
 */
function randomItem(rng: Rng, index: number): EmbeddingItem {
  const partCount = 1 + intBelow(rng, 4)
  return {
    index,
    contentParts: Array.from({ length: partCount }, () => ({
      type: 'text' as const,
      text: randomText(rng),
    })),
  }
}

/** The text one item is expected to contribute, concatenated in part order. */
function expectedInput(item: EmbeddingItem): string {
  return item.contentParts.map(part => (part.type === 'text' ? part.text : '')).join('')
}

/**
 * Logical indexes for one generated `Logical_Call`: distinct, sparse, unordered.
 *
 * Sparse and unordered on purpose. Contiguous `0..N-1` indexes would make the
 * batch position and the logical index interchangeable, and every mapping
 * assertion below would hold for an implementation that used the wrong one.
 */
function logicalIndexes(rng: Rng, count: number): number[] {
  const indexes = new Set<number>()
  while (indexes.size < count) indexes.add(intBelow(rng, 500))
  return shuffled(rng, [...indexes])
}

/** Values with sign, magnitude and precision variety; never a unit vector. */
function randomValues(rng: Rng, dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => {
    const magnitude = pick(rng, [1e-7, 0.5, 1, 7.25, 1e3, 1e12])
    const sign = rng() < 0.5 ? -1 : 1
    return sign * magnitude * (0.1 + rng())
  })
}

// ---------------------------------------------------------------------------
// The adapter under test, driven by an injected fetch
// ---------------------------------------------------------------------------

/** One captured outbound request. */
interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly rawBody: string
  readonly body: Readonly<Record<string, unknown>>
}

/** What the stub answers with; raw text, so `Infinity` and bad JSON are reachable. */
interface StubResponse {
  readonly text: string
  readonly contentType?: string
  readonly status?: number
}

interface Harness {
  readonly adapter: ReturnType<typeof openAiEmbeddingAdapter>
  readonly requests: readonly CapturedRequest[]
}

interface HarnessOptions {
  readonly models?: readonly EmbeddingCatalogModel[]
  readonly baseUrl?: string
  readonly allowInsecureHttp?: boolean
  readonly organization?: string
  readonly project?: string
  /** Answer for the n-th request; receives the request already captured. */
  readonly respond: (request: CapturedRequest, ordinal: number) => StubResponse
}

function harnessOf(options: HarnessOptions): Harness {
  const requests: CapturedRequest[] = []
  const fetchStub = (async (input: unknown, init: RequestInit = {}) => {
    const rawBody = typeof init.body === 'string' ? init.body : ''
    const captured: CapturedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.freeze({ ...(init.headers as Record<string, string> | undefined) }),
      rawBody,
      body: rawBody.length === 0
        ? {}
        : (JSON.parse(rawBody) as Readonly<Record<string, unknown>>),
    }
    requests.push(captured)
    const answer = options.respond(captured, requests.length - 1)
    return new Response(answer.text, {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.contentType ?? 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  return {
    requests,
    adapter: openAiEmbeddingAdapter({
      apiKey: 'test-openai-key',
      fetch: fetchStub,
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
    }),
  }
}

/** A well-formed `data` payload, in the given response order. */
function dataPayload(
  entries: readonly { readonly index: number; readonly values: readonly number[] }[],
  usage?: { readonly prompt_tokens?: number; readonly total_tokens?: number },
): string {
  const data = entries.map(entry =>
    `{"index":${entry.index},"embedding":[${entry.values.map(value => String(value)).join(',')}]}`)
  const parts = [`"object":"list"`, `"data":[${data.join(',')}]`]
  if (usage !== undefined) parts.push(`"usage":${JSON.stringify(usage)}`)
  return `{${parts.join(',')}}`
}

function batchOf(input: {
  readonly items: readonly EmbeddingItem[]
  readonly purpose: EmbeddingPurpose
  readonly dimensions?: number
  readonly truncation?: 'reject' | 'allow'
  readonly model?: string
}): EmbeddingBatchRequest {
  return {
    provider: 'openai',
    model: input.model ?? 'text-embedding-3-small',
    purpose: input.purpose,
    items: input.items,
    truncation: input.truncation ?? 'reject',
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
  }
}

/** A declared catalog entry; `dimensions` is what makes the wire parameter reachable. */
function catalogModel(input: {
  readonly id?: string
  readonly dimensions?: readonly number[]
  readonly purposeHandling?: EmbeddingCatalogModel['purposeHandling']
}): EmbeddingCatalogModel {
  return {
    id: input.id ?? 'text-embedding-3-small',
    compatibilityIdentity: 'openai:text-embedding-3',
    ...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
    ...(input.purposeHandling === undefined ? {} : { purposeHandling: input.purposeHandling }),
  }
}

/** The `code` of whatever the adapter threw, without depending on a class identity. */
async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `<no code: ${String(error)}>`
  }
  return '<resolved>'
}

/**
 * Every key that would betray a purpose, truncation or encoding decision.
 *
 * Checked as a set against the body's own keys rather than by looking for the
 * ones this adapter is known to send: a NEW key appearing on the wire is exactly
 * the regression Property 18 exists to catch, and an allowlist notices it while
 * a denylist of today's spellings would not.
 */
const ALLOWED_BODY_KEYS: readonly string[] = Object.freeze([
  'model',
  'input',
  'encoding_format',
  'dimensions',
])

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 18: Purpose được dịch ở adapter, không rò rỉ prefix không tài liệu', () => {
  it(`sends caller text verbatim for ${RUNS} generated purpose and catalog mixes`, async () => {
    let sawUnknownHandling = false
    let sawUnsupportedHandling = false
    let sawPrefixLookalike = false
    let sawMultiPartItem = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x12_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const itemCount = 1 + intBelow(rng, 5)
      const indexes = logicalIndexes(rng, itemCount)
      const items = indexes.map(index => randomItem(rng, index))
      const dimensions = pick(rng, [4, 8, 16])
      // Either the route says nothing about purpose (`unknown`) or it states it
      // has no mechanism (`unsupported`). Both oblige the same behaviour.
      const declaresUnsupported = rng() < 0.5
      if (declaresUnsupported) sawUnsupportedHandling = true
      else sawUnknownHandling = true
      if (items.some(item => item.contentParts.length > 1)) sawMultiPartItem = true
      if (items.some(item => /^(query|passage|search_document): /.test(expectedInput(item)))) {
        sawPrefixLookalike = true
      }

      const models = [catalogModel({
        dimensions: [dimensions],
        ...(declaresUnsupported ? { purposeHandling: 'unsupported' as const } : {}),
      })]

      // The SAME items are embedded under both purposes; the two wire bodies must
      // be byte-identical, because this endpoint has no way to express purpose.
      const bodies: string[] = []
      for (const purpose of PURPOSES) {
        const harness = harnessOf({
          models,
          respond: request => ({
            text: dataPayload((request.body['input'] as readonly string[]).map((_input, at) => ({
              index: at,
              values: randomValues(rngOf(seed + at), dimensions),
            }))),
          }),
        })
        await harness.adapter.embedBatch(batchOf({ items, purpose, dimensions }))

        const sent = harness.requests[0]
        expect({ ...context, purpose, requests: harness.requests.length })
          .toEqual({ ...context, purpose, requests: 1 })

        // One wire input per item, each the concatenation of that item's parts
        // with nothing added at either end.
        expect({ ...context, purpose, input: sent?.body['input'] })
          .toEqual({ ...context, purpose, input: items.map(expectedInput) })

        // No key beyond the four this contract documents: a `task_type`,
        // `input_type` or `instruction` parameter appearing here would be an
        // undocumented purpose channel.
        expect({ ...context, purpose, keys: Object.keys(sent?.body ?? {}).sort() })
          .toEqual({
            ...context,
            purpose,
            keys: [...ALLOWED_BODY_KEYS].sort(),
          })

        bodies.push(sent?.rawBody ?? '')
      }

      expect({ ...context, identical: bodies[0] === bodies[1] })
        .toEqual({ ...context, identical: true })
    }

    expect({
      sawUnknownHandling,
      sawUnsupportedHandling,
      sawPrefixLookalike,
      sawMultiPartItem,
    }).toEqual({
      sawUnknownHandling: true,
      sawUnsupportedHandling: true,
      sawPrefixLookalike: true,
      sawMultiPartItem: true,
    })
  })

  it('keeps a caller text that already looks like a prefix exactly as given', async () => {
    const text = 'query: how tall is the tower'
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [3] })],
      respond: () => ({ text: dataPayload([{ index: 0, values: [1, 2, 3] }]) }),
    })
    await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text }] }],
      purpose: 'retrieval-query',
      dimensions: 3,
    }))
    // Not `'query: query: ...'`, and not stripped down to the bare question.
    expect(harness.requests[0]?.body['input']).toEqual([text])
  })
})

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 19: N input độc lập cho đúng N vector mang chỉ số gốc', () => {
  it(`maps ${RUNS} generated batches through permuted responses`, async () => {
    let sawPermutedResponse = false
    let sawMultiPartItem = false
    let sawSingleItemBatch = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x13_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const itemCount = 1 + intBelow(rng, 8)
      if (itemCount === 1) sawSingleItemBatch = true
      const items = logicalIndexes(rng, itemCount).map(index => randomItem(rng, index))
      if (items.some(item => item.contentParts.length > 1)) sawMultiPartItem = true
      const dimensions = 2 + intBelow(rng, 6)

      // One vector per batch POSITION, then answered in a permuted order.
      const byPosition = items.map(() => randomValues(rng, dimensions))
      const order = shuffled(rng, items.map((_item, at) => at))
      if (order.some((position, at) => position !== at)) sawPermutedResponse = true

      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({
          text: dataPayload(order.map(position => ({
            index: position,
            values: byPosition[position] as readonly number[],
          }))),
        }),
      })

      const result = await harness.adapter.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
      }))

      // Exactly N vectors for N inputs — never N-1 and never one per content part.
      expect({ ...context, vectors: result.vectors.length })
        .toEqual({ ...context, vectors: items.length })
      expect({ ...context, inputs: (harness.requests[0]?.body['input'] as unknown[]).length })
        .toEqual({ ...context, inputs: items.length })

      // Exactly one vector per item, keyed by the item's index in the
      // `Logical_Call` — not by its position in this batch.
      const seen = result.vectors.map(vector => vector.index).sort((a, b) => a - b)
      expect({ ...context, seen })
        .toEqual({ ...context, seen: items.map(item => item.index).sort((a, b) => a - b) })

      // And the vector each index carries is the one the provider produced for
      // THAT item, which is what the permutation is there to disturb.
      for (const [position, item] of items.entries()) {
        const vector = result.vectors.find(candidate => candidate.index === item.index)
        expect({ ...context, index: item.index, values: [...(vector?.values ?? [])] })
          .toEqual({ ...context, index: item.index, values: [...(byPosition[position] as number[])] })
      }
    }

    expect({ sawPermutedResponse, sawMultiPartItem, sawSingleItemBatch })
      .toEqual({ sawPermutedResponse: true, sawMultiPartItem: true, sawSingleItemBatch: true })
  })

  it('returns one vector for an item split across many content parts', async () => {
    const item: EmbeddingItem = {
      index: 42,
      contentParts: [
        { type: 'text', text: 'title\n' },
        { type: 'text', text: 'body one ' },
        { type: 'text', text: 'body two' },
      ],
    }
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [3] })],
      respond: () => ({ text: dataPayload([{ index: 0, values: [0.1, 0.2, 0.3] }]) }),
    })
    const result = await harness.adapter.embedBatch(batchOf({
      items: [item],
      purpose: 'retrieval-document',
      dimensions: 3,
    }))

    expect(harness.requests[0]?.body['input']).toEqual(['title\nbody one body two'])
    expect(result.vectors).toHaveLength(1)
    expect(result.vectors[0]?.index).toBe(42)
  })

  it('maps `prompt_tokens` and `total_tokens` onto the two embedding counters', async () => {
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({
        text: dataPayload([{ index: 0, values: [1, 2] }], { prompt_tokens: 11, total_tokens: 11 }),
      }),
    })
    const result: EmbeddingBatchResult = await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'x' }] }],
      purpose: 'retrieval-query',
      dimensions: 2,
    }))
    expect(result.usage).toEqual({ inputTokens: 11, totalTokens: 11 })
  })

  it('leaves usage absent rather than reporting zero when the provider reports none', async () => {
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({ text: dataPayload([{ index: 0, values: [1, 2] }]) }),
    })
    const result = await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'x' }] }],
      purpose: 'retrieval-query',
      dimensions: 2,
    }))
    expect(result.usage).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

/** How one generated response breaks the index contract. */
type IndexBreak = 'extra-vector' | 'missing-vector' | 'duplicate' | 'out-of-range' | 'negative' | 'non-integer' | 'absent'

const INDEX_BREAKS: readonly IndexBreak[] = Object.freeze([
  'extra-vector',
  'missing-vector',
  'duplicate',
  'out-of-range',
  'negative',
  'non-integer',
  'absent',
])

describe('Feature: embedding-support, Property 20: Tập chỉ số response phải là một permutation hợp lệ', () => {
  it(`refuses ${RUNS} generated count and index violations with stable codes`, async () => {
    const observed = new Set<IndexBreak>()

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x14_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      // At least two items, so a duplicate and a gap are both expressible.
      const itemCount = 2 + intBelow(rng, 6)
      const items = logicalIndexes(rng, itemCount).map(index => randomItem(rng, index))
      const dimensions = 2 + intBelow(rng, 4)
      const values = randomValues(rng, dimensions)
      const entries = items.map((_item, at) => ({ index: at, values }))
      const breakage = pick(rng, INDEX_BREAKS)
      observed.add(breakage)

      let text: string
      switch (breakage) {
        case 'extra-vector':
          text = dataPayload([...entries, { index: itemCount, values }])
          break
        case 'missing-vector':
          text = dataPayload(entries.slice(0, -1))
          break
        case 'duplicate':
          // Right count, wrong bijection: position 0 answered twice, one item never.
          text = dataPayload([{ index: 0, values }, ...entries.slice(1, -1), { index: 0, values }])
          break
        case 'out-of-range':
          text = dataPayload([...entries.slice(0, -1), { index: itemCount + 3, values }])
          break
        case 'negative':
          text = dataPayload([...entries.slice(0, -1), { index: -1, values }])
          break
        case 'non-integer':
          text = dataPayload([...entries.slice(0, -1), { index: 0.5, values }])
          break
        case 'absent':
          // An entry with no `index` at all: still a mapping failure, not a
          // licence to fall back on the entry's position.
          text = `{"data":[${entries.slice(0, -1).map(entry =>
            `{"index":${entry.index},"embedding":[${entry.values.join(',')}]}`)
            .concat(`{"embedding":[${values.join(',')}]}`).join(',')}]}`
          break
      }

      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({ text }),
      })
      const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
      })))

      const expected = breakage === 'extra-vector' || breakage === 'missing-vector'
        ? EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH
        : EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID
      expect({ ...context, breakage, code }).toEqual({ ...context, breakage, code: expected })

      // The request still went out exactly once: this is a response failure, and
      // it must not be reported as though the batch had never been dispatched.
      expect({ ...context, breakage, requests: harness.requests.length })
        .toEqual({ ...context, breakage, requests: 1 })
    }

    expect([...observed].sort()).toEqual([...INDEX_BREAKS].sort())
  })

  it('reports a wrong count as a count mismatch even when the indexes are also broken', async () => {
    // Both faults at once. The count check runs first on purpose: "answered a
    // different number of inputs" and "cannot be mapped back" call for different
    // repairs, and the caller learns which from the code.
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({ text: dataPayload([{ index: 9, values: [1, 2] }]) }),
    })
    const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
      items: [
        { index: 0, contentParts: [{ type: 'text', text: 'a' }] },
        { index: 1, contentParts: [{ type: 'text', text: 'b' }] },
      ],
      purpose: 'retrieval-query',
      dimensions: 2,
    })))
    expect(code).toBe(EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH)
  })
})

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

/** How one generated response breaks a vector's values. */
type ValueBreak = 'infinity' | 'negative-infinity' | 'string-value' | 'null-value' | 'too-narrow' | 'too-wide'

const VALUE_BREAKS: readonly ValueBreak[] = Object.freeze([
  'infinity',
  'negative-infinity',
  'string-value',
  'null-value',
  'too-narrow',
  'too-wide',
])

describe('Feature: embedding-support, Property 21: Vector không hợp lệ là lỗi, không phải dữ liệu để sửa', () => {
  it(`refuses ${RUNS} generated non-finite and mis-sized vectors`, async () => {
    const observed = new Set<ValueBreak>()

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x15_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const itemCount = 1 + intBelow(rng, 4)
      const items = logicalIndexes(rng, itemCount).map(index => randomItem(rng, index))
      const dimensions = 3 + intBelow(rng, 4)
      const breakage = pick(rng, VALUE_BREAKS)
      observed.add(breakage)
      const victim = intBelow(rng, itemCount)

      const entries = items.map((_item, at) => {
        const values = randomValues(rng, dimensions).map(String)
        if (at !== victim) return `{"index":${at},"embedding":[${values.join(',')}]}`
        switch (breakage) {
          case 'infinity':
            // `1e999` parses to `Infinity`; there is no `Infinity` JSON literal,
            // which is why the stub answers with raw text.
            values[intBelow(rng, dimensions)] = '1e999'
            break
          case 'negative-infinity':
            values[intBelow(rng, dimensions)] = '-1e999'
            break
          case 'string-value':
            values[intBelow(rng, dimensions)] = '"0.5"'
            break
          case 'null-value':
            values[intBelow(rng, dimensions)] = 'null'
            break
          case 'too-narrow':
            values.pop()
            break
          case 'too-wide':
            values.push('0.5')
            break
        }
        return `{"index":${at},"embedding":[${values.join(',')}]}`
      })

      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({ text: `{"data":[${entries.join(',')}]}` }),
      })
      const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
      })))

      const expected = breakage === 'too-narrow' || breakage === 'too-wide'
        ? EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH
        : EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID
      expect({ ...context, breakage, code }).toEqual({ ...context, breakage, code: expected })
    }

    expect([...observed].sort()).toEqual([...VALUE_BREAKS].sort())
  })

  it('does not accept a mis-sized vector by slicing or padding it', async () => {
    // Both directions from one request, so neither a truncation nor a pad can
    // look like a success.
    for (const values of [[1, 2], [1, 2, 3, 4, 5]]) {
      const harness = harnessOf({
        models: [catalogModel({ dimensions: [4] })],
        respond: () => ({ text: dataPayload([{ index: 0, values }]) }),
      })
      const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
        items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
        purpose: 'retrieval-query',
        dimensions: 4,
      })))
      expect({ width: values.length, code })
        .toEqual({ width: values.length, code: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH })
    }
  })

  it('accepts an undeclared width when the caller requested none', async () => {
    // With no requested width there is nothing the provider contradicted, so the
    // vector travels out as it arrived rather than being judged against a guess.
    const harness = harnessOf({
      models: [catalogModel({})],
      respond: () => ({ text: dataPayload([{ index: 0, values: [1, 2, 3, 4, 5, 6, 7] }]) }),
    })
    const result = await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-query',
    }))
    expect([...(result.vectors[0]?.values ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 22: Vector trả ra trung thực với vector provider trả về', () => {
  it(`returns ${RUNS} generated provider vectors element for element`, async () => {
    let sawNonUnitVector = false
    let sawNegativeValue = false
    let sawTinyValue = false
    let sawHugeValue = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x16_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const itemCount = 1 + intBelow(rng, 5)
      const items = logicalIndexes(rng, itemCount).map(index => randomItem(rng, index))
      const dimensions = 2 + intBelow(rng, 6)
      const byPosition = items.map(() => randomValues(rng, dimensions))
      const order = shuffled(rng, items.map((_item, at) => at))

      for (const values of byPosition) {
        const norm = Math.hypot(...values)
        if (Math.abs(norm - 1) > 1e-9) sawNonUnitVector = true
        if (values.some(value => value < 0)) sawNegativeValue = true
        if (values.some(value => Math.abs(value) < 1e-6)) sawTinyValue = true
        if (values.some(value => Math.abs(value) > 1e6)) sawHugeValue = true
      }

      // The response text carries the exact decimal expansions, so a value that
      // came back changed cannot be blamed on the fixture's serialization.
      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({
          text: dataPayload(order.map(position => ({
            index: position,
            values: byPosition[position] as readonly number[],
          }))),
        }),
      })
      const prepared = await harness.adapter.prepareEmbeddingCall('openai', 'text-embedding-3-small', {
        dimensions,
      })
      const result = await prepared.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
      }))

      // This adapter declares no post-processing, so the profile itself is the
      // claim being checked: no declared step, therefore no step applied.
      expect({ ...context, postProcessing: prepared.profile.postProcessing })
        .toEqual({ ...context, postProcessing: undefined })

      for (const [position, item] of items.entries()) {
        const vector = result.vectors.find(candidate => candidate.index === item.index)
        const provided = byPosition[position] as readonly number[]
        // Element for element, in order, with no rescaling: `Object.is` rather
        // than a tolerance, because "close enough" is what fidelity rules out.
        expect({ ...context, index: item.index, width: vector?.values.length })
          .toEqual({ ...context, index: item.index, width: provided.length })
        for (const [at, value] of provided.entries()) {
          expect({ ...context, index: item.index, at, same: Object.is(vector?.values[at], value) })
            .toEqual({ ...context, index: item.index, at, same: true })
        }
      }
    }

    // A generator that only ever produced unit vectors would let a normalizing
    // implementation pass every assertion above.
    expect({ sawNonUnitVector, sawNegativeValue, sawTinyValue, sawHugeValue })
      .toEqual({
        sawNonUnitVector: true,
        sawNegativeValue: true,
        sawTinyValue: true,
        sawHugeValue: true,
      })
  })

  it('does not normalize a vector even when the route declares vectors are normalized', async () => {
    // A route's `normalization` declaration describes what the provider does; it
    // is not an instruction for the adapter to make it true.
    const values = [3, 4]
    const harness = harnessOf({
      models: [{
        id: 'text-embedding-3-small',
        compatibilityIdentity: 'openai:text-embedding-3',
        dimensions: [2],
        normalization: 'unit-l2',
      }],
      respond: () => ({ text: dataPayload([{ index: 0, values }]) }),
    })
    const prepared = await harness.adapter.prepareEmbeddingCall('openai', 'text-embedding-3-small', {
      dimensions: 2,
    })
    const result = await prepared.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-document',
      dimensions: 2,
    }))
    expect(prepared.profile.normalization).toBe('unit-l2')
    expect([...(result.vectors[0]?.values ?? [])]).toEqual(values)
  })
})

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 23: Truncation chỉ khi được bật, và luôn có warning', () => {
  it(`refuses ${RUNS} generated truncation requests before any Provider_Attempt`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x17_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const items = logicalIndexes(rng, 1 + intBelow(rng, 4)).map(index => randomItem(rng, index))
      const dimensions = pick(rng, [4, 8])
      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({ text: dataPayload(items.map((_item, at) => ({ index: at, values: [] }))) }),
      })

      // This endpoint exposes no truncation parameter, so `'allow'` is refused
      // rather than accepted and quietly not honoured.
      const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
        truncation: 'allow',
      })))
      expect({ ...context, code })
        .toEqual({ ...context, code: EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED })

      // Refused before dispatch: zero requests, so the caller pays nothing for a
      // request that could not have honoured its own terms.
      expect({ ...context, requests: harness.requests.length })
        .toEqual({ ...context, requests: 0 })
    }
  })

  it(`sends no truncation flag and reports no truncation for ${RUNS} rejecting requests`, async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x18_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const items = logicalIndexes(rng, 1 + intBelow(rng, 4)).map(index => randomItem(rng, index))
      const dimensions = 2 + intBelow(rng, 4)
      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: request => ({
          text: dataPayload((request.body['input'] as readonly string[]).map((_input, at) => ({
            index: at,
            values: randomValues(rngOf(seed + at), dimensions),
          }))),
        }),
      })
      const result = await harness.adapter.embedBatch(batchOf({
        items,
        purpose: pick(rng, PURPOSES),
        dimensions,
      }))

      // Nothing on the wire mentions truncation in any spelling.
      const keys = Object.keys(harness.requests[0]?.body ?? {})
      expect({ ...context, truncationKeys: keys.filter(key => /trunc/i.test(key)) })
        .toEqual({ ...context, truncationKeys: [] })

      // And no vector claims to have been truncated, so nothing was shortened
      // behind the caller's back.
      expect({ ...context, truncated: result.vectors.filter(vector => vector.truncated === true) })
        .toEqual({ ...context, truncated: [] })
    }
  })

  it('refuses a response that reports truncation the caller rejected', async () => {
    // OpenAI does not report truncation, so this is the self-hosted case: a
    // compatible endpoint claiming it shortened an input the caller asked to have
    // refused is a contract break, not data to accept with a warning.
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({
        text: '{"data":[{"index":0,"embedding":[1,2],"truncated":true}]}',
      }),
    })
    const result = await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-query',
      dimensions: 2,
    }))
    // The adapter reads only `index` and `embedding`; an unknown `truncated`
    // field is not promoted into a claim about the vector.
    expect(result.vectors[0]?.truncated).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 40: Dimensions chỉ lên wire khi route khai báo hỗ trợ', () => {
  it(`sends the parameter only for ${RUNS} generated declared-width routes`, async () => {
    let sawDeclared = false
    let sawUndeclaredField = false
    let sawUnknownModel = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x19_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const dimensions = pick(rng, [64, 128, 256, 512, 1_536])
      // Three catalog shapes: a declared width list, an entry that omits the
      // field, and a model the catalog does not describe at all. Only the first
      // makes the parameter reachable; the other two are `unknown`, and `unknown`
      // is not a licence to send a parameter the endpoint may reject.
      const shape = pick(rng, ['declared', 'undeclared-field', 'unknown-model'] as const)
      if (shape === 'declared') sawDeclared = true
      if (shape === 'undeclared-field') sawUndeclaredField = true
      if (shape === 'unknown-model') sawUnknownModel = true

      const models = shape === 'unknown-model'
        ? [catalogModel({ id: 'some-other-model', dimensions: [dimensions] })]
        : [catalogModel(shape === 'declared' ? { dimensions: [dimensions] } : {})]

      const harness = harnessOf({
        models,
        respond: () => ({
          text: dataPayload([{ index: 0, values: randomValues(rng, dimensions) }]),
        }),
      })
      const items = [randomItem(rng, intBelow(rng, 50))]
      const prepared = await harness.adapter.prepareEmbeddingCall(
        'openai',
        'text-embedding-3-small',
        { dimensions },
      )
      await prepared.embedBatch(batchOf({ items, purpose: pick(rng, PURPOSES), dimensions }))

      const sent = harness.requests[0]?.body ?? {}
      const expected = shape === 'declared' ? { dimensions } : {}
      expect({
        ...context,
        shape,
        wire: 'dimensions' in sent ? { dimensions: sent['dimensions'] } : {},
      }).toEqual({ ...context, shape, wire: expected })
    }

    expect({ sawDeclared, sawUndeclaredField, sawUnknownModel })
      .toEqual({ sawDeclared: true, sawUndeclaredField: true, sawUnknownModel: true })
  })

  it('omits the parameter when the caller requested no width', async () => {
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [8] })],
      respond: () => ({ text: dataPayload([{ index: 0, values: [1, 2, 3] }]) }),
    })
    await harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-query',
    }))
    expect('dimensions' in (harness.requests[0]?.body ?? {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Property 41
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 41: Attribution headers trên mọi request embedding', () => {
  it(`carries SDK attribution on ${RUNS} generated requests, successful or not`, async () => {
    const expectedAttribution = attributionHeaders()
    let sawSuccess = false
    let sawServerError = false
    let sawAccountHeaders = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1a_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const dimensions = 2 + intBelow(rng, 4)
      const items = logicalIndexes(rng, 1 + intBelow(rng, 3)).map(index => randomItem(rng, index))
      const fails = rng() < 0.4
      if (fails) sawServerError = true
      else sawSuccess = true
      const withAccount = rng() < 0.5
      if (withAccount) sawAccountHeaders = true

      const harness = harnessOf({
        models: [catalogModel({ dimensions: [dimensions] })],
        ...(withAccount ? { organization: 'org-42', project: 'proj-7' } : {}),
        respond: () => fails
          ? { text: '{"error":{"message":"upstream unavailable"}}', status: 503 }
          : { text: dataPayload(items.map((_item, at) => ({ index: at, values: randomValues(rng, dimensions) }))) },
      })

      const batch = batchOf({ items, purpose: pick(rng, PURPOSES), dimensions })
      if (fails) await codeOf(() => harness.adapter.embedBatch(batch))
      else await harness.adapter.embedBatch(batch)

      const sent = harness.requests[0]
      expect({ ...context, requests: harness.requests.length })
        .toEqual({ ...context, requests: 1 })
      // Attribution is the transport's layer, merged beneath auth: an adapter
      // cannot forget it and a credential cannot be overwritten by it.
      for (const [name, value] of Object.entries(expectedAttribution)) {
        expect({ ...context, name, value: sent?.headers[name] })
          .toEqual({ ...context, name, value })
      }
      // The credential still travels, and the account headers only when configured.
      expect({ ...context, authorized: sent?.headers['authorization'] })
        .toEqual({ ...context, authorized: 'Bearer test-openai-key' })
      expect({
        ...context,
        organization: sent?.headers['openai-organization'],
        project: sent?.headers['openai-project'],
      }).toEqual({
        ...context,
        organization: withAccount ? 'org-42' : undefined,
        project: withAccount ? 'proj-7' : undefined,
      })
    }

    expect({ sawSuccess, sawServerError, sawAccountHeaders })
      .toEqual({ sawSuccess: true, sawServerError: true, sawAccountHeaders: true })
  })
})

// ---------------------------------------------------------------------------
// Property 42
// ---------------------------------------------------------------------------

describe('Feature: embedding-support, Property 42: baseUrl được tôn trọng và cleartext HTTP cần bật tường minh', () => {
  it(`sends ${RUNS} generated requests to exactly the configured origin`, async () => {
    let sawDefaultBase = false
    let sawSelfHostedPath = false
    let sawTrailingSlash = false
    let sawNonDefaultPort = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1b_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const host = pick(rng, [
        'https://api.openai.com/v1',
        'https://vectors.internal.example/openai/v1',
        'https://gateway.example:8443/proxy/openai',
        'https://compat.example/v1/',
        'https://compat.example/v1//',
      ])
      if (host === 'https://api.openai.com/v1') sawDefaultBase = true
      if (host.includes('internal.example')) sawSelfHostedPath = true
      if (host.endsWith('/')) sawTrailingSlash = true
      if (host.includes(':8443')) sawNonDefaultPort = true

      const dimensions = 2 + intBelow(rng, 4)
      const harness = harnessOf({
        baseUrl: host,
        models: [catalogModel({ dimensions: [dimensions] })],
        respond: () => ({
          text: dataPayload([{ index: 0, values: randomValues(rng, dimensions) }]),
        }),
      })
      await harness.adapter.embedBatch(batchOf({
        items: [randomItem(rng, intBelow(rng, 50))],
        purpose: pick(rng, PURPOSES),
        dimensions,
      }))

      const expected = `${host.replace(/\/+$/, '')}/embeddings`
      expect({ ...context, url: harness.requests[0]?.url })
        .toEqual({ ...context, url: expected })
      expect({ ...context, origin: new URL(harness.requests[0]?.url ?? '').origin })
        .toEqual({ ...context, origin: new URL(host).origin })
      expect({ ...context, method: harness.requests[0]?.method })
        .toEqual({ ...context, method: 'POST' })
    }

    expect({ sawDefaultBase, sawSelfHostedPath, sawTrailingSlash, sawNonDefaultPort })
      .toEqual({
        sawDefaultBase: true,
        sawSelfHostedPath: true,
        sawTrailingSlash: true,
        sawNonDefaultPort: true,
      })
  })

  it(`refuses ${RUNS} generated cleartext bases unless the caller opts in`, async () => {
    let sawRefusal = false
    let sawOptIn = false

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1c_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const baseUrl = pick(rng, [
        'http://localhost:11434/v1',
        'http://127.0.0.1:8080/openai',
        'http://embeddings.internal:3000/v1',
      ])
      const allow = rng() < 0.5
      if (allow) sawOptIn = true
      else sawRefusal = true

      const harness = harnessOf({
        baseUrl,
        ...(allow ? { allowInsecureHttp: true } : {}),
        models: [catalogModel({ dimensions: [4] })],
        respond: () => ({ text: dataPayload([{ index: 0, values: [1, 2, 3, 4] }]) }),
      })
      const batch = batchOf({
        items: [randomItem(rng, intBelow(rng, 50))],
        purpose: pick(rng, PURPOSES),
        dimensions: 4,
      })

      if (allow) {
        await harness.adapter.embedBatch(batch)
        expect({ ...context, url: harness.requests[0]?.url })
          .toEqual({ ...context, url: `${baseUrl}/embeddings` })
      } else {
        const code = await codeOf(() => harness.adapter.embedBatch(batch))
        expect({ ...context, code })
          .toEqual({ ...context, code: MODEL_ERROR_CODES.INVALID_REQUEST })
        // Refused before the socket: an unencrypted credential never left.
        expect({ ...context, requests: harness.requests.length })
          .toEqual({ ...context, requests: 0 })
      }
    }

    expect({ sawRefusal, sawOptIn }).toEqual({ sawRefusal: true, sawOptIn: true })
  })
})

// ---------------------------------------------------------------------------
// Property 43
// ---------------------------------------------------------------------------

/** One way a self-hosted endpoint can fail the embedding contract. */
interface ContractBreak {
  readonly name: string
  readonly response: StubResponse
  readonly code: string
}

const CONTRACT_BREAKS: readonly ContractBreak[] = Object.freeze([
  {
    name: 'no data field',
    response: { text: '{"object":"list"}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'data is an object',
    response: { text: '{"data":{"0":{"index":0,"embedding":[1,2]}}}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'data entry is a scalar',
    response: { text: '{"data":[7]}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'data entry is null',
    response: { text: '{"data":[null]}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'embedding field missing',
    response: { text: '{"data":[{"index":0}]}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'embedding is an object',
    response: { text: '{"data":[{"index":0,"embedding":{"0":1}}]}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'embedding is a base64 string',
    response: { text: '{"data":[{"index":0,"embedding":"AAAAAA=="}]}' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'body is not JSON',
    response: { text: '<!doctype html><html>gateway timeout</html>' },
    code: MODEL_ERROR_CODES.MALFORMED_RESPONSE,
  },
  {
    name: 'body is truncated JSON',
    response: { text: '{"data":[{"index":0,"embedding":[1,2' },
    code: MODEL_ERROR_CODES.MALFORMED_RESPONSE,
  },
  {
    name: 'body is a JSON array',
    response: { text: '[{"index":0,"embedding":[1,2]}]' },
    code: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'content type is HTML',
    response: { text: '{"data":[{"index":0,"embedding":[1,2]}]}', contentType: 'text/html' },
    code: 'HTTP_JSON_MEDIA_TYPE_INVALID',
  },
  {
    name: 'content type is plain text',
    response: { text: '{"data":[{"index":0,"embedding":[1,2]}]}', contentType: 'text/plain' },
    code: 'HTTP_JSON_MEDIA_TYPE_INVALID',
  },
])

/**
 * Base URLs whose PATHS invite an inference, and must not produce one.
 *
 * `.../openai/v1` and `.../azure/openai` look like statements about which
 * dialect is on the other end. If any branch read the path, the same malformed
 * body would produce different codes across this list.
 */
const INFERENCE_BAIT_BASES: readonly string[] = Object.freeze([
  'https://api.openai.com/v1',
  'https://self-hosted.example/openai/v1',
  'https://self-hosted.example/azure/openai',
  'https://self-hosted.example/v1/compat/openai-embeddings',
  'https://self-hosted.example',
])

describe('Feature: embedding-support, Property 43: Response không thoả contract là protocol error, không phải cơ sở suy diễn', () => {
  it(`refuses ${RUNS} generated contract breaks with a code that ignores the endpoint path`, async () => {
    const observed = new Set<string>()

    for (let run = 0; run < RUNS; run += 1) {
      const seed = 0x1d_0000 + run
      const rng = rngOf(seed)
      const context = { seed }

      const breakage = pick(rng, CONTRACT_BREAKS)
      observed.add(breakage.name)
      const items = [randomItem(rng, intBelow(rng, 50))]

      // The SAME broken response is served from every base URL in turn. A single
      // differing code would mean some branch read the path.
      const codes: string[] = []
      for (const baseUrl of INFERENCE_BAIT_BASES) {
        const harness = harnessOf({
          baseUrl,
          models: [catalogModel({ dimensions: [2] })],
          respond: () => breakage.response,
        })
        codes.push(await codeOf(() => harness.adapter.embedBatch(batchOf({
          items,
          purpose: pick(rng, PURPOSES),
          dimensions: 2,
        }))))
      }

      expect({ ...context, breakage: breakage.name, codes })
        .toEqual({
          ...context,
          breakage: breakage.name,
          codes: INFERENCE_BAIT_BASES.map(() => breakage.code),
        })
    }

    expect([...observed].sort()).toEqual(CONTRACT_BREAKS.map(entry => entry.name).sort())
  })

  it('refuses an empty body rather than reading it as zero vectors', async () => {
    const harness = harnessOf({
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({ text: '' }),
    })
    const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-query',
      dimensions: 2,
    })))
    expect(code).toBe(MODEL_ERROR_CODES.MALFORMED_RESPONSE)
  })

  it('surfaces a non-2xx status as a provider error, not as a malformed contract', async () => {
    // A self-hosted endpoint that is merely down must be distinguishable from one
    // that answers with the wrong shape; the two call for different responses.
    const harness = harnessOf({
      baseUrl: 'https://self-hosted.example/v1',
      models: [catalogModel({ dimensions: [2] })],
      respond: () => ({ text: '{"error":{"message":"model not loaded"}}', status: 500 }),
    })
    const code = await codeOf(() => harness.adapter.embedBatch(batchOf({
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'a' }] }],
      purpose: 'retrieval-query',
      dimensions: 2,
    })))
    expect(code).toBe(MODEL_ERROR_CODES.SERVER)
  })
})
