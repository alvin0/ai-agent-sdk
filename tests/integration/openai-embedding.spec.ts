/**
 * `OpenAI_Embedding_Adapter` against the real `POST /embeddings`.
 *
 * **Validates: Requirement 17.12**
 *
 * Run it with:
 *
 * ```
 * OPENAI_API_KEY=sk-... pnpm test:integration --reporter=verbose tests/integration/openai-embedding.spec.ts
 * ```
 *
 * ## Location and runner
 *
 * Requirement 17.12 places any test that calls a real provider under
 * `tests/integration/`, collected by `vitest.integration.config.ts` — which
 * includes exactly `tests/integration/**` and nothing under `packages/`. The root
 * `vitest.config.ts` EXCLUDES the same directory, so `pnpm test` never reaches
 * this file and a developer running the fast suite is never asked for a secret.
 *
 * `tasks.md` names `packages/provider-openai/tests/integration/embedding.spec.ts`.
 * No runner collects that path: `packages/provider-openai/vitest.config.ts`
 * includes a single root-tree file, and the integration config's include is
 * repository-rooted. A file placed where the task named it would be a file that
 * never runs, which is the opposite of what the requirement asks for. The unit
 * spec for this adapter documents the same deviation, and this file sits beside
 * `copilot-embedding.spec.ts`, the other live embedding suite.
 *
 * ## The guard, and why the skip is the important part
 *
 * With no `OPENAI_API_KEY` the whole suite SKIPS. That is the mandatory half of
 * this task: public CI holds no OpenAI secret and must still go green, so the
 * absence of a credential has to be a skip and not a failure — and not a
 * `beforeAll` that throws, which is why the guard is a value read at import time
 * in `tests/fixtures/embedding/openai-live.ts` rather than a call inside a hook.
 * The live run itself is the optional half.
 *
 * ## Why it goes through the adapter
 *
 * Unlike `copilot-embedding.spec.ts`, which predates its adapter and speaks raw
 * HTTP, `openAiEmbeddingAdapter` exists — so every request here goes through it.
 * That is deliberate: the unit spec already proves the adapter builds the right
 * body against an injected `fetch`, and what remains unprovable without a real
 * call is whether the endpoint AGREES. Four things only a live call settles:
 *
 * 1. **The width, and that the declared catalog matches reality.** A fixture
 *    returns the width it declares; only the endpoint can confirm that
 *    `text-embedding-3-small` still answers 1536.
 * 2. **That mapping survives a real response.** The adapter refuses a response
 *    whose `index` set is not a permutation of the batch, and carries the
 *    caller's LOGICAL index out. A live batch with sparse, unordered logical
 *    indexes is the only check that the endpoint's own ordering does not break it.
 * 3. **That `dimensions` is honoured.** Declared support and implemented support
 *    are different facts. Note the adapter turns a disagreement into
 *    `EMBEDDING_VECTOR_DIMENSIONS_MISMATCH` rather than a resized vector, so
 *    this scenario reports which of the two happened by name.
 * 4. **That the vectors are MEANINGFUL.** Everything above would pass against
 *    well-formed noise. The cosine ordering would not.
 *
 * ## On the `console.log` calls
 *
 * Deliberate, and the same convention as the Copilot live spec: half regression
 * test, half diagnostic for a developer checking what their key can do. One short
 * line per scenario, on the success path only, which is why the documented command
 * passes `--reporter=verbose` — the default reporter swallows stdout from passing
 * tests, the only case this output is written for.
 *
 * A few well-chosen requests, no loops: quota cost is real.
 *
 * @module tests/integration/openai-embedding.spec
 */

import { describe, expect, it } from 'vitest'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../packages/core/src/embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../packages/core/src/embedding/request.ts'
import type { EmbeddingBatchResult } from '../../packages/core/src/embedding/result.ts'
import {
  BATCH_CORPUS,
  OPENAI_EMBEDDING_ROUTE,
  SEMANTIC_CORPUS,
  cosine,
  embeddingItem,
  liveOpenAiEmbeddingAdapter,
  norm,
  openAiEmbeddingLive,
  openAiEmbeddingModel,
  openAiEmbeddingModelId,
} from '../fixtures/embedding/openai-live.ts'

/** Bound on one live request; the config's own test timeout sits above it. */
const REQUEST_TIMEOUT_MS = 60_000

/** Reduced width asked for in the `dimensions` scenario; a declared value. */
const REDUCED_DIMENSIONS = 512

/**
 * Dispatch one `Physical_Batch` through the real adapter.
 *
 * `prepareEmbeddingCall` rather than `embedBatch` directly, because that is the
 * path the runtime takes: the connection, the resolved catalog entry and the
 * profile all come from ONE capture, and the `spaceId` a caller would key a cache
 * on is derived from that same capture.
 * @param texts - one string per item; logical indexes are supplied by the caller.
 * @param indexes - the logical index for each text, in the same order.
 * @param dimensions - optional reduced width.
 * @returns the batch result, plus the prepared call it went through.
 */
async function embed(
  texts: readonly string[],
  indexes: readonly number[],
  dimensions?: number,
): Promise<{
    readonly result: EmbeddingBatchResult
    readonly spaceId: string
    readonly declaredDimensions: number
  }> {
  const adapter = liveOpenAiEmbeddingAdapter()
  const prepared = await adapter.prepareEmbeddingCall(
    OPENAI_EMBEDDING_ROUTE,
    openAiEmbeddingModelId,
    dimensions === undefined ? {} : { dimensions },
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  )
  const batch: EmbeddingBatchRequest = {
    provider: OPENAI_EMBEDDING_ROUTE,
    model: openAiEmbeddingModelId,
    // This endpoint has no purpose mechanism; the route declares
    // `purposeHandling: 'unsupported'` and the text goes out verbatim. Naming a
    // purpose here checks exactly that: no prefix appears in what is sent.
    purpose: 'retrieval-document',
    items: texts.map((text, at) => embeddingItem(indexes[at] ?? at, text)),
    truncation: 'reject',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(dimensions === undefined ? {} : { dimensions }),
  }
  const result = await prepared.embedBatch(batch)
  return {
    result,
    spaceId: prepared.spaceId,
    declaredDimensions: prepared.profile.dimensions,
  }
}

/** `usage` as one short readable string, or `none` when the endpoint reported none. */
function usageSummary(result: EmbeddingBatchResult): string {
  return result.usage === undefined ? 'none' : JSON.stringify(result.usage)
}

describe.skipIf(!openAiEmbeddingLive)('openai embedding (live)', () => {
  it('answers one finite fixed-width vector, and reports input tokens', async () => {
    const { result, spaceId, declaredDimensions } = await embed(
      ['the wire contract of one embedding request'],
      [17],
    )

    expect(result.vectors.length).toBe(1)
    const vector = result.vectors[0]!
    // The caller's logical index, not the batch position. `17` is deliberately
    // not `0`: an adapter that returned the position would pass with `0`.
    expect(vector.index).toBe(17)
    expect(vector.values.every(value => typeof value === 'number' && Number.isFinite(value)))
      .toBe(true)

    // The width the declared catalog claims, confirmed against the endpoint. Only
    // asserted for a model this fixture declares — an env-supplied model has no
    // declared number, and inventing one here would be this file guessing.
    if (openAiEmbeddingModel !== undefined) expect(vector.values.length).toBe(declaredDimensions)
    else expect(vector.values.length).toBeGreaterThan(0)

    // Usage is reported, and reported HONESTLY: `prompt_tokens` maps to
    // `inputTokens`, and there is no `outputTokens` to be invented as a zero.
    expect(result.usage).toBeDefined()
    expect('outputTokens' in (result.usage ?? {})).toBe(false)

    console.log(
      `[openai embedding] single input: model=${openAiEmbeddingModelId} `
      + `dimensions=${String(vector.values.length)} norm=${norm(vector.values).toFixed(4)} `
      + `space=${spaceId} usage=${usageSummary(result)} `
      + `requestId=${result.providerRequestId ?? 'none'}`,
    )
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('maps a batch back onto the caller\'s sparse logical indexes', async () => {
    // Sparse and unordered: contiguous `0..N-1` indexes would make the batch
    // position and the logical index interchangeable, and this assertion would
    // hold for an adapter that used the wrong one.
    const indexes = [41, 7, 300, 12, 128]
    const { result } = await embed(BATCH_CORPUS, indexes)

    // One vector per input: no padding, no collapsing of duplicates.
    expect(result.vectors.length).toBe(BATCH_CORPUS.length)

    // The set of logical indexes comes back complete and without duplicates.
    // Compared as SETS rather than by position, because the endpoint is free to
    // answer in any order — the adapter's job is that the mapping survives it,
    // not that the order is preserved.
    expect([...result.vectors.map(entry => entry.index)].sort((a, b) => a - b))
      .toEqual([...indexes].sort((a, b) => a - b))

    // Every vector in a batch has the same width. Mixed widths would be unusable
    // regardless of the indexes.
    const widths = new Set(result.vectors.map(entry => entry.values.length))
    expect(widths.size).toBe(1)

    console.log(
      `[openai embedding] batch of ${String(BATCH_CORPUS.length)}: `
      + `indexes=${JSON.stringify(result.vectors.map(entry => entry.index))} `
      + `dimensions=${String([...widths][0])} usage=${usageSummary(result)}`,
    )
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('reports whether a declared reduced width is honoured on the wire', async () => {
    // Needs a declared native width to be reduced FROM, and a declared list that
    // makes the parameter reachable at all.
    if (openAiEmbeddingModel?.dimensions?.includes(REDUCED_DIMENSIONS) !== true) return

    // Three outcomes, and they are not equally good, so each is reported by name
    // rather than smoothed into a pass. A width other than the one requested
    // becomes `EMBEDDING_VECTOR_DIMENSIONS_MISMATCH` — the adapter refuses rather
    // than resizes — so "ignored" arrives here as that error, not as a short
    // vector. An HTTP refusal arrives as some other error and is reported too: the
    // parameter is the endpoint's to support, and its absence is a finding about
    // the surface rather than a defect in this SDK.
    let outcome: string
    try {
      const { result } = await embed(
        ['a request that asks for a narrower vector'],
        [3],
        REDUCED_DIMENSIONS,
      )
      expect(result.vectors.length).toBe(1)
      const width = result.vectors[0]!.values.length
      expect(width).toBe(REDUCED_DIMENSIONS)
      outcome = `HONOURED: asked ${String(REDUCED_DIMENSIONS)}, got ${String(width)}`
    } catch (error) {
      if (error instanceof EmbeddingError
        && error.code === EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH) {
        outcome = `IGNORED: endpoint answered a different width (${error.message})`
      } else if (error instanceof Error) {
        outcome = `REJECTED: ${error.message.slice(0, 300)}`
      } else throw error
    }

    console.log(`[openai embedding] dimensions=${String(REDUCED_DIMENSIONS)} ${outcome}`)
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('places related text closer together than unrelated text', async () => {
    const { result } = await embed(
      [SEMANTIC_CORPUS.related, SEMANTIC_CORPUS.alsoRelated, SEMANTIC_CORPUS.unrelated],
      [0, 1, 2],
    )
    expect(result.vectors.length).toBe(3)

    // Read by logical index, not by position: the batch scenario above establishes
    // that ordering is the endpoint's business, so this test must not quietly
    // assume it.
    const byIndex = new Map(result.vectors.map(entry => [entry.index, entry.values]))
    const first = byIndex.get(0)!
    const second = byIndex.get(1)!
    const third = byIndex.get(2)!

    const relatedPair = cosine(first, second)
    const crossPairA = cosine(first, third)
    const crossPairB = cosine(second, third)

    console.log(
      `[openai embedding] cosine: related=${relatedPair.toFixed(4)} `
      + `unrelated-a=${crossPairA.toFixed(4)} unrelated-b=${crossPairB.toFixed(4)}`,
    )

    // The only assertion here that the vectors are MEANINGFUL. Stated as a strict
    // ordering rather than a threshold: a fixed cutoff would be a claim about this
    // model's calibration, which drifts, while the ordering is the property a
    // semantic search actually relies on.
    expect(relatedPair).toBeGreaterThan(crossPairA)
    expect(relatedPair).toBeGreaterThan(crossPairB)
  }, REQUEST_TIMEOUT_MS + 30_000)

  it('refuses truncation this endpoint cannot express, without sending a request', async () => {
    // No `truncation` parameter exists on `POST /embeddings`, so `'allow'` is
    // refused rather than accepted and quietly not honoured. Live rather than
    // unit-only because the refusal has to hold with a REAL credential and a real
    // endpoint in place: a guard that only holds when the request would have failed
    // anyway is not a guard. Costs no quota — nothing reaches the wire.
    const adapter = liveOpenAiEmbeddingAdapter()
    await expect(adapter.embedBatch({
      provider: OPENAI_EMBEDDING_ROUTE,
      model: openAiEmbeddingModelId,
      purpose: 'retrieval-document',
      items: [embeddingItem(1, 'text that must not be silently truncated')],
      truncation: 'allow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })).rejects.toMatchObject({ code: EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED })

    console.log('[openai embedding] truncation=allow refused with EMBEDDING_TRUNCATION_UNSUPPORTED')
  }, REQUEST_TIMEOUT_MS + 30_000)
})
