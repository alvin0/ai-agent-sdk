/**
 * The Copilot embedding surface against the real endpoint — and the trial run a
 * developer reaches for right after `npm run provider:copilot:login-device` to see
 * whether embedding actually works on their account.
 *
 * Run it with `npm run provider:copilot:embedding`.
 *
 * Excluded from `npm test` — `vitest.config.ts` excludes `tests/integration/**` —
 * and run only by `vitest.integration.config.ts` (Requirement 16.4). With no
 * credential in the Node default `Copilot_Credential_Store` the suite SKIPS itself
 * instead of failing (Requirement 16.5); see `tests/helpers/copilot-live.ts` for the
 * guard.
 *
 * ## Why this speaks raw HTTP instead of using an adapter
 *
 * `Copilot_Embedding_Adapter` DOES NOT EXIST YET: task 13.x is blocked on the
 * separate `embedding-support` spec, so there is no `EmbeddingAdapter` for Copilot to
 * import. Importing one would make this file fail to load rather than skip, which is
 * the opposite of what Requirement 16.5 asks for. So the requests here go straight to
 * `POST /embeddings` with the exchanged `Copilot_Api_Token` and the two mandatory
 * editor headers.
 *
 * **When task 13.x lands, rewrite `embed()` below to go through
 * `copilotEmbeddingPlugin` / `Copilot_Embedding_Adapter`.** The assertions stay: they
 * are claims about the ENDPOINT, and they are what an adapter has to keep true.
 *
 * ## What only a live call can settle
 *
 * Four things, and each one is a separate request because each answers a different
 * question:
 *
 * 1. **The dimension count and the exact response shape.** A mock returns the shape
 *    its fixture declares, so it cannot tell you that this account's
 *    `text-embedding-3-small` still answers 1536 dimensions, nor that the body
 *    carries `data` and `usage` but NO `model` field — which is exactly the kind of
 *    absence an adapter must not be written to depend on.
 * 2. **That a batch keeps the caller's ordering recoverable.** This is Property 47:
 *    the `index` on each vector is the index of the input in the LOGICAL CALL, and
 *    the endpoint is free to answer out of order. Asserting the indices form a
 *    permutation of `0..n-1` — rather than assuming position — is the mapping
 *    guarantee every real caller depends on, and no unit fixture can confirm the
 *    endpoint honours it.
 * 3. **Whether `dimensions` is honoured.** The live catalog advertises
 *    `supports.dimensions: true` for `text-embedding-3-small`. Advertised and
 *    implemented are different facts, and only a request settles which one this is.
 * 4. **That the vectors are MEANINGFUL, not merely well-shaped.** Everything above
 *    would still pass against an endpoint returning well-formed noise. The cosine
 *    check is the one test that would not.
 *
 * ## On the `console.log` calls
 *
 * They are deliberate. This file is half regression test, half diagnostic: its other
 * job is to tell a developer who just signed in what their account can do, and a
 * silent green run tells them nothing. The output is one short line per scenario,
 * printed on the success path only. The `provider:copilot:embedding` script passes
 * `--reporter=verbose` for exactly this reason — the default reporter swallows
 * stdout from tests that pass, which is the only case this output is written for.
 *
 * A few well-chosen requests, no loops. Quota cost is real, and the design says so
 * explicitly for live scenarios.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import {
  COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  partitionCopilotCatalog,
  type CopilotEmbeddingModel,
} from '../../packages/provider-copilot/src/catalog.ts'
import {
  COPILOT_BASE_URL,
  copilotLive,
  copilotLiveHeaders,
  fetchCopilotCatalogBody,
  liveCopilotApiToken,
} from '../helpers/copilot-live.ts'

/** The model this account is known to serve; the catalog decides whether it is there. */
const PREFERRED_MODEL = 'text-embedding-3-small'
/** Dimensions `text-embedding-3-small` returns when `dimensions` is not sent. */
const EXPECTED_DIMENSIONS = 1536
/**
 * The reduced width requested from the `dimensions` parameter.
 *
 * A divisor of the native width, and well under the catalog's `limits.max_inputs`
 * of 512 — the two numbers are unrelated, but picking 512 keeps the reduction
 * obviously non-trivial while staying a value the surface has no reason to reject.
 */
const REDUCED_DIMENSIONS = 512
const REQUEST_TIMEOUT_MS = 60_000

/** The embedding half of the account's catalog, read once. */
let embeddingModels: readonly CopilotEmbeddingModel[] = []

/** One `POST /embeddings` response, unpacked just far enough to assert against. */
interface EmbeddingResult {
  readonly status: number
  readonly body: Record<string, unknown>
  /** The `data` entries, in the order the endpoint returned them. */
  readonly data: readonly Record<string, unknown>[]
}

/**
 * Issue one real `POST /embeddings`.
 *
 * A fresh token per call rather than one shared across the file: the exchange is
 * cheap, and a suite that ran long enough to see a token expire would fail for a
 * reason that has nothing to do with embedding.
 * @param model - the model id to send.
 * @param input - the inputs, as the caller's logical batch.
 * @param dimensions - the optional reduced width; omitted from the body when absent.
 * @returns the status, the parsed body, and its `data` entries.
 */
async function embed(
  model: string,
  input: readonly string[],
  dimensions?: number,
): Promise<EmbeddingResult> {
  const apiToken = await liveCopilotApiToken(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  const response = await fetch(new URL('/embeddings', COPILOT_BASE_URL), {
    method: 'POST',
    headers: copilotLiveHeaders(apiToken),
    body: JSON.stringify({ model, input, ...dimensions === undefined ? {} : { dimensions } }),
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const parsed: unknown = await response.json().catch(() => undefined)
  const body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const data = (Array.isArray(body.data) ? body.data : []).filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  )
  return { status: response.status, body, data }
}

/**
 * The model this run uses, preferring the one whose width is known.
 *
 * @returns a model id, or `undefined` when the account's plan exposes no embedding
 *   model at all.
 */
function embeddingModel(): string | undefined {
  if (embeddingModels.length === 0) return undefined
  return embeddingModels.some(entry => entry.id === PREFERRED_MODEL)
    ? PREFERRED_MODEL
    : embeddingModels[0]!.id
}

/**
 * Read a `data` entry's vector, asserting it is a vector of finite numbers.
 *
 * The finiteness check lives here rather than in one test because it is a claim
 * about every vector this file ever receives: a `null` or a string among the
 * components is the negative case the unit fixtures cover, and it must not appear
 * live.
 * @param entry - one `data` entry.
 * @returns the components.
 */
function vectorOf(entry: Record<string, unknown>): readonly number[] {
  const embedding = entry.embedding
  expect(Array.isArray(embedding)).toBe(true)
  const values = embedding as readonly unknown[]
  expect(values.every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true)
  return values as readonly number[]
}

/**
 * Cosine similarity of two equal-width vectors.
 *
 * @param left - the first vector.
 * @param right - the second vector, same width.
 * @returns the similarity in `[-1, 1]`.
 */
function cosine(left: readonly number[], right: readonly number[]): number {
  expect(left.length).toBe(right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [index, value] of left.entries()) {
    const other = right[index]!
    dot += value * other
    leftNorm += value * value
    rightNorm += other * other
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/** Total prompt/total token count from `usage`, when the endpoint reports one. */
function usageSummary(body: Record<string, unknown>): string {
  const usage = body.usage
  if (typeof usage !== 'object' || usage === null) return 'none'
  return JSON.stringify(usage)
}

beforeAll(async () => {
  if (!copilotLive) return
  const apiToken = await liveCopilotApiToken(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  const body = await fetchCopilotCatalogBody(apiToken, AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  embeddingModels = partitionCopilotCatalog(body, COPILOT_DEFAULT_MAX_CATALOG_MODELS).embedding
  console.log(
    `[copilot embedding] account exposes ${String(embeddingModels.length)} embedding model(s): `
    + `${embeddingModels.map(entry => entry.id).join(', ') || '(none)'}`,
  )
})

describe.skipIf(!copilotLive)('copilot embedding (live)', () => {
  it('returns a fixed-width vector, plus usage and no model field, for one real input', async () => {
    // An account whose plan exposes no embedding model has nothing to check here.
    // Reported as a pass rather than a failure: the absence is a property of the
    // account, not a defect in this SDK.
    const model = embeddingModel()
    if (model === undefined) return

    const { status, body, data } = await embed(model, ['the wire contract of one embedding request'])
    expect(status).toBe(200)

    // Shape: `data` and `usage` are present, `model` is NOT. The absence is asserted
    // rather than ignored, because an adapter that reads `body.model` to label a
    // vector would work against every other provider and silently produce
    // `undefined` here.
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.usage).toBeTypeOf('object')
    expect('model' in body).toBe(false)

    expect(data.length).toBe(1)
    const values = vectorOf(data[0]!)

    // The width is the fact a mock cannot know. Asserted only for the model whose
    // width is known; any other model is checked for a plausible vector instead of
    // for a number this file would be inventing.
    if (model === PREFERRED_MODEL) expect(values.length).toBe(EXPECTED_DIMENSIONS)
    else expect(values.length).toBeGreaterThan(0)

    console.log(
      `[copilot embedding] single input: model=${model} dimensions=${String(values.length)} `
      + `usage=${usageSummary(body)}`,
    )
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('answers one vector per input and labels each with its index in the logical call', async () => {
    const model = embeddingModel()
    if (model === undefined) return

    // Five inputs of visibly different lengths: if the endpoint ever reordered by
    // size or by token count, uniform inputs would hide it.
    const inputs = [
      'alpha',
      'a moderately longer sentence about database indexes',
      'beta',
      'the quick brown fox jumps over the lazy dog, twice, for good measure',
      'gamma',
    ]
    const { status, body, data } = await embed(model, inputs)
    expect(status).toBe(200)

    // One vector per input, no padding and no collapsing of duplicates.
    expect(data.length).toBe(inputs.length)

    // Property 47: the indices are the caller's, and they are complete. Sorting
    // before comparing is the point — a response that came back out of order is
    // still CORRECT as long as every logical index appears exactly once, and that
    // is precisely the guarantee a caller needs to map vectors back to inputs.
    // Asserting positional order instead would pass today and hide a reordering
    // the moment the endpoint batched differently.
    const indices = data.map(entry => entry.index)
    expect(indices.every(index => typeof index === 'number')).toBe(true)
    expect([...indices as readonly number[]].sort((a, b) => a - b))
      .toEqual(inputs.map((_, index) => index))

    // Every vector in a batch has the same width as every other. A batch that
    // returned mixed widths would be unusable regardless of the indices.
    const widths = new Set(data.map(entry => vectorOf(entry).length))
    expect(widths.size).toBe(1)

    console.log(
      `[copilot embedding] batch of ${String(inputs.length)}: indices=${JSON.stringify(indices)} `
      + `dimensions=${String([...widths][0])} usage=${usageSummary(body)}`,
    )
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('reports whether the dimensions parameter is honoured on this surface', async () => {
    const model = embeddingModel()
    // Only meaningful for the model whose native width is known: "reduced" needs
    // something to be reduced FROM.
    if (model !== PREFERRED_MODEL) return

    const { status, body, data } = await embed(model, ['a request that asks for a narrower vector'], REDUCED_DIMENSIONS)

    // Three outcomes, and they are not equally good — so each is reported by name
    // rather than smoothed into a pass. The endpoint advertises
    // `supports.dimensions: true`; this test exists to check that the advertisement
    // is true, and a rejection or a silent ignore is real information about the
    // surface, not a flake. Only the honoured case asserts a width, because only
    // that case has a width to assert.
    if (status !== 200) {
      console.log(
        `[copilot embedding] dimensions=${String(REDUCED_DIMENSIONS)} REJECTED with HTTP `
        + `${String(status)}: ${JSON.stringify(body).slice(0, 300)}`,
      )
      // A rejection is a finding, not a failure of this SDK: the parameter is the
      // endpoint's to support. Recorded loudly above and left as a pass, the same
      // way the generation spec treats an account's own model refusal.
      return
    }

    expect(data.length).toBe(1)
    const width = vectorOf(data[0]!).length
    if (width === REDUCED_DIMENSIONS) {
      console.log(
        `[copilot embedding] dimensions HONOURED: asked ${String(REDUCED_DIMENSIONS)}, `
        + `got ${String(width)} (native ${String(EXPECTED_DIMENSIONS)})`,
      )
    } else {
      console.log(
        `[copilot embedding] dimensions IGNORED: asked ${String(REDUCED_DIMENSIONS)}, `
        + `got ${String(width)}`,
      )
    }
    // Whichever way it went, the surface must answer a coherent vector — one of the
    // two widths and nothing else. A third number would mean the parameter is doing
    // something unpredictable, and an adapter could not be written against that.
    expect([REDUCED_DIMENSIONS, EXPECTED_DIMENSIONS]).toContain(width)
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('places related text closer together than unrelated text', async () => {
    const model = embeddingModel()
    if (model === undefined) return

    // Two sentences about the same thing and one about something else. The point is
    // not subtlety — a coarse gap is what makes the check stable enough to assert
    // without turning into a model-quality benchmark.
    const [related, alsoRelated, unrelated] = [
      'How do I create an index on a PostgreSQL table?',
      'Adding a database index to speed up SQL queries in Postgres.',
      'A recipe for slow-roasted lamb shoulder with rosemary and garlic.',
    ]
    const { status, data } = await embed(model, [related, alsoRelated, unrelated])
    expect(status).toBe(200)
    expect(data.length).toBe(3)

    // Read by `index`, not by position — the batch test above establishes that the
    // ordering is the endpoint's business, so this test must not quietly assume it.
    const byIndex = new Map(data.map(entry => [entry.index as number, vectorOf(entry)]))
    const first = byIndex.get(0)!
    const second = byIndex.get(1)!
    const third = byIndex.get(2)!

    const relatedPair = cosine(first, second)
    const crossPairA = cosine(first, third)
    const crossPairB = cosine(second, third)

    console.log(
      `[copilot embedding] cosine: related=${relatedPair.toFixed(4)} `
      + `unrelated-a=${crossPairA.toFixed(4)} unrelated-b=${crossPairB.toFixed(4)}`,
    )

    // The only assertion in this file that the vectors are MEANINGFUL. Every other
    // check here would pass against well-shaped noise; this one would not, because
    // noise has no reason to put the two Postgres sentences nearer each other than
    // either is to the lamb. Stated as a strict ordering rather than a threshold: a
    // fixed cutoff would be a claim about this model's calibration, which drifts,
    // while the ordering is the property a semantic search actually relies on.
    expect(relatedPair).toBeGreaterThan(crossPairA)
    expect(relatedPair).toBeGreaterThan(crossPairB)
  }, REQUEST_TIMEOUT_MS + 30_000)
})
