/**
 * `Gemini_Embedding_Adapter` against the real `batchEmbedContents` endpoint.
 *
 * Excluded from `npm test` — `vitest.config.ts` excludes `tests/integration/**` — and
 * collected only by `vitest.integration.config.ts`, which is the location and runner
 * Requirement 17.12 asks for. Run it with `npm run test:integration`, or just this
 * file with `vitest run --config vitest.integration.config.ts --reporter=verbose
 * tests/integration/gemini-embedding.spec.ts`.
 *
 * With no `GEMINI_KEY` exported the whole suite SKIPS itself rather than failing; the
 * guard is `tests/fixtures/embedding/gemini-live.ts`. That split is deliberate: the
 * file, the fixture and the skip are the mandatory half of 17.12, and the actual
 * round trip is the optional half, because it needs a secret public CI does not hold.
 *
 * ## Why this goes through the runtime rather than raw HTTP
 *
 * `geminiEmbeddingPlugin` exists, so the thing worth checking live is the whole path
 * a caller uses: `createAgentRuntime()` → `embeddingModel()` → `embed()` /
 * `embedMany()`. Speaking raw HTTP here would test the endpoint and leave the adapter,
 * the profile and the usage aggregation — the parts this SDK is responsible for —
 * unexercised against a real response.
 *
 * ## What only a live call can settle
 *
 * Four things, one request each, because each answers a different question:
 *
 *  1. **The width and the shape.** A fixture returns the shape it declares, so it
 *     cannot tell you that this account's `gemini-embedding-001` still answers 3072
 *     components, nor that the body carries `embeddings` and NO usage block. That
 *     absence is asserted rather than ignored: it is what makes the aggregated report
 *     `missing` plus a `usage-unreported` warning, and no zero is invented for it.
 *  2. **That positional mapping is sound.** `batchEmbedContents` returns no index of
 *     its own, so the adapter assigns one from request order and checks the count.
 *     Only a real batch can confirm the endpoint honours the pairing that assumption
 *     rests on.
 *  3. **That `outputDimensionality` is honoured and the recorded step is real.** The
 *     profile declares `l2-renormalize` for a narrower-than-native request; the live
 *     check is that the returned width is the one asked for AND the vector actually
 *     comes back unit-length, which is the step being claimed.
 *  4. **That the vectors are MEANINGFUL, not merely well-shaped.** Everything above
 *     would pass against well-formed noise. The cosine ordering would not.
 *
 * ## On the `console.log` calls
 *
 * Deliberate, and consistent with `copilot-embedding.spec.ts`: this file doubles as a
 * diagnostic for a developer who just exported a key, and a silent green run tells
 * them nothing. One short line per scenario, on the success path only — pass
 * `--reporter=verbose` to see it, since the default reporter swallows stdout from
 * passing tests.
 *
 * A few well-chosen requests, no loops: live quota is real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import type { AgentRuntime } from '@alvin0/ai-agent-sdk-core'
import type { EmbeddingModelHandle } from '@alvin0/ai-agent-sdk-core'
import { geminiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'
import {
  GEMINI_BATCH_INPUTS,
  GEMINI_LIVE_EMBEDDING_MODEL,
  GEMINI_LIVE_ROUTE,
  GEMINI_LIVE_TIMEOUT_MS,
  GEMINI_NATIVE_DIMENSIONS,
  GEMINI_REDUCED_DIMENSIONS,
  GEMINI_SEMANTIC_CORPUS,
  cosine,
  geminiEmbeddingLive,
  geminiLiveKey,
  l2Norm,
} from '../fixtures/embedding/gemini-live.ts'

/** Slack over the per-request bound, so the test times out after the request does. */
const TEST_TIMEOUT_MS = GEMINI_LIVE_TIMEOUT_MS + 30_000

/** The runtime under test; embedding-only, so no agent or team could be built. */
let runtime: AgentRuntime | undefined

/**
 * A handle at the requested width.
 *
 * `dimensions` is a HANDLE option, so one runtime serves both the native and the
 * narrowed scenario — which is also what makes the two `Space_Id`s comparable.
 * @param dimensions - requested width, or `undefined` for the model default.
 * @returns the handle.
 */
function handleAt(dimensions?: number): EmbeddingModelHandle {
  if (runtime === undefined) throw new Error('no runtime; the suite should have skipped')
  return runtime.embeddingModel({
    provider: GEMINI_LIVE_ROUTE,
    model: GEMINI_LIVE_EMBEDDING_MODEL,
    ...(dimensions === undefined ? {} : { dimensions }),
  })
}

describe.skipIf(!geminiEmbeddingLive)('gemini embedding (live)', () => {
  beforeAll(async () => {
    runtime = await createAgentRuntime({
      providers: [geminiEmbeddingPlugin({
        apiKey: geminiLiveKey as string,
        routes: [GEMINI_LIVE_ROUTE],
        requestTimeoutMs: GEMINI_LIVE_TIMEOUT_MS,
      })],
    })
    console.log(
      `[gemini embedding] route=${GEMINI_LIVE_ROUTE} model=${GEMINI_LIVE_EMBEDDING_MODEL}`,
    )
  })

  afterAll(async () => {
    if (runtime === undefined) return
    const report = await runtime.close()
    runtime = undefined
    // Nothing agent-shaped was built, so nothing agent-shaped is torn down, and every
    // embedding call has settled by now.
    expect(report.state).toBe('closed')
    expect(report.activeRunsAtClose).toBe(0)
  })

  it('answers a native-width vector and reports usage as missing rather than zero', async () => {
    const result = await handleAt().embed({
      value: 'the wire contract of one Gemini embedding request',
      purpose: 'retrieval-document',
    })

    expect(result.embedding.length).toBe(GEMINI_NATIVE_DIMENSIONS)
    // Every component finite: a `null` or a string among them is the negative case the
    // unit fixtures cover, and it must not appear live.
    expect(result.embedding.every(value => Number.isFinite(value))).toBe(true)
    expect(result.space).toContain('google:gemini-embedding-001')
    expect(result.profile.dimensions).toBe(GEMINI_NATIVE_DIMENSIONS)
    // Native width means no narrowing, so no recorded step.
    expect(result.profile.postProcessing).toBeUndefined()

    // `batchEmbedContents` reports no usage at all. The report says so and publishes
    // no `tokens`; a `0` here would be a number this SDK invented (Requirement 16.2).
    expect(result.usage.status).toBe('missing')
    expect(result.usage.tokens).toBeUndefined()
    expect(result.usage.batches).toBe(1)
    expect(result.usage.batchesWithUsage).toBe(0)
    expect(result.usage.providerAttempts).toBe(1)
    expect(result.usage.inputsFromProvider).toBe(1)
    expect(result.usage.inputsFromCache).toBe(0)
    expect(result.warnings.map(warning => warning.code)).toContain('usage-unreported')

    console.log(
      `[gemini embedding] single input: dimensions=${String(result.embedding.length)} `
      + `usage=${result.usage.status} space=${result.space}`,
    )
  }, TEST_TIMEOUT_MS)

  it('answers one vector per input, in input order, at one width', async () => {
    const result = await handleAt().embedMany({
      values: GEMINI_BATCH_INPUTS,
      purpose: 'retrieval-document',
    })

    // One vector per input: no padding, no collapsing of duplicates.
    expect(result.embeddings).toHaveLength(GEMINI_BATCH_INPUTS.length)
    const widths = new Set(result.embeddings.map(vector => vector.length))
    expect([...widths]).toEqual([GEMINI_NATIVE_DIMENSIONS])
    expect(result.embeddings.every(vector => vector.every(value => Number.isFinite(value))))
      .toBe(true)

    // Ordering is the claim. The response carries no index, so the adapter's
    // positional mapping is only sound if distinct inputs come back distinct and in
    // place — checked by embedding the first input again on its own and finding it at
    // position 0, not merely somewhere in the batch.
    const [first] = GEMINI_BATCH_INPUTS
    const alone = await handleAt().embed({ value: first as string, purpose: 'retrieval-document' })
    const atZero = cosine(alone.embedding, result.embeddings[0] as readonly number[])
    const atLast = cosine(
      alone.embedding,
      result.embeddings[result.embeddings.length - 1] as readonly number[],
    )
    expect(atZero).toBeGreaterThan(atLast)
    // The same text through the same configuration: near-identical, allowing for the
    // model's own non-determinism rather than demanding bit equality.
    expect(atZero).toBeGreaterThan(0.99)

    expect(result.usage.batches).toBeGreaterThanOrEqual(1)
    expect(result.usage.inputsFromProvider).toBe(GEMINI_BATCH_INPUTS.length)

    console.log(
      `[gemini embedding] batch of ${String(GEMINI_BATCH_INPUTS.length)}: `
      + `dimensions=${String([...widths][0])} batches=${String(result.usage.batches)} `
      + `cosine(pos0)=${atZero.toFixed(4)} cosine(posLast)=${atLast.toFixed(4)}`,
    )
  }, TEST_TIMEOUT_MS)

  it('honours a narrower width and performs the l2-renormalize step it records', async () => {
    const native = await handleAt().embed({
      value: 'a request that asks for a narrower vector',
      purpose: 'retrieval-query',
    })
    const reduced = await handleAt(GEMINI_REDUCED_DIMENSIONS).embed({
      value: 'a request that asks for a narrower vector',
      purpose: 'retrieval-query',
    })

    // The model produced the narrower vector itself; nothing here sliced or padded.
    expect(reduced.embedding.length).toBe(GEMINI_REDUCED_DIMENSIONS)
    expect(reduced.profile.dimensions).toBe(GEMINI_REDUCED_DIMENSIONS)
    expect(reduced.profile.postProcessing).toEqual({ kind: 'l2-renormalize', revision: '1' })
    expect(reduced.profile.normalization).toBe('unit-l2')
    // The recorded step, actually performed: a narrower Gemini vector is not
    // unit-length as it arrives, so a norm of 1 is evidence the adapter did the work
    // its profile claims.
    expect(l2Norm(reduced.embedding)).toBeCloseTo(1, 5)

    // A different width and a different post-processing step are different spaces, so
    // the two results are not comparable and the `Space_Id` has to say so.
    expect(reduced.space).not.toBe(native.space)

    console.log(
      `[gemini embedding] reduced: asked ${String(GEMINI_REDUCED_DIMENSIONS)}, got `
      + `${String(reduced.embedding.length)}, norm=${l2Norm(reduced.embedding).toFixed(6)}`,
    )
  }, TEST_TIMEOUT_MS)

  it('places related text closer together than unrelated text', async () => {
    const { related, alsoRelated, unrelated } = GEMINI_SEMANTIC_CORPUS
    const result = await handleAt().embedMany({
      values: [related, alsoRelated, unrelated],
      purpose: 'retrieval-document',
    })
    expect(result.embeddings).toHaveLength(3)

    const [first, second, third] = result.embeddings as readonly (readonly number[])[]
    const relatedPair = cosine(first as readonly number[], second as readonly number[])
    const crossA = cosine(first as readonly number[], third as readonly number[])
    const crossB = cosine(second as readonly number[], third as readonly number[])

    console.log(
      `[gemini embedding] cosine: related=${relatedPair.toFixed(4)} `
      + `unrelated-a=${crossA.toFixed(4)} unrelated-b=${crossB.toFixed(4)}`,
    )

    // The one assertion here that the vectors mean something. Stated as an ordering
    // rather than a threshold: a fixed cutoff would be a claim about this model's
    // calibration, which drifts, while the ordering is what a semantic search relies
    // on.
    expect(relatedPair).toBeGreaterThan(crossA)
    expect(relatedPair).toBeGreaterThan(crossB)
  }, TEST_TIMEOUT_MS)

  it('translates purpose into taskType without changing the embedding space', async () => {
    // Property 17 as a live check: purpose is a wire parameter for Gemini, so it
    // changes the REQUEST but must not change the space — a query and a document
    // embedded through one configuration have to remain comparable.
    const query = await handleAt().embed({
      value: 'how to add an index in postgres',
      purpose: 'retrieval-query',
    })
    const document = await handleAt().embed({
      value: 'Adding a database index to speed up SQL queries in Postgres.',
      purpose: 'retrieval-document',
    })

    expect(query.space).toBe(document.space)
    expect(query.embedding.length).toBe(document.embedding.length)
    // Comparable in the way a retrieval system depends on: the query lands near the
    // document that answers it.
    const similarity = cosine(query.embedding, document.embedding)
    expect(similarity).toBeGreaterThan(0)

    console.log(
      `[gemini embedding] purpose: shared space=${query.space} `
      + `query·document=${similarity.toFixed(4)}`,
    )
  }, TEST_TIMEOUT_MS)
})
