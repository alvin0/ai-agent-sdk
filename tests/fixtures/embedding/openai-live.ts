/**
 * The credential guard, the declared route catalog and the small corpus shared by
 * the OpenAI embedding live spec.
 *
 * ## Why a fixture at all
 *
 * `openAiEmbeddingAdapter` ships NO built-in catalog, for the same reason the
 * generation adapter ships no model list: a stale list would name retired models.
 * A route that wants `dimensions` on the wire, or wants to state which embedding
 * space its vectors belong to, has to DECLARE its models — so a live run needs a
 * declaration, and that declaration is data, not test logic. Keeping it here also
 * means the widths the spec asserts against and the widths the adapter is allowed
 * to send come from ONE place; two copies would be free to drift, and the drift
 * would look like an endpoint change.
 *
 * ## Why the guard reads the environment
 *
 * Unlike Copilot, OpenAI has no credential store in this repository — there is no
 * `openai-login` writing a file somewhere for an adapter to find. The single place
 * an OpenAI key can come from is the process environment, so that is the only
 * place the guard looks. Every way the read can come up short — variable unset,
 * empty, whitespace — collapses into `undefined`, because to a suite deciding
 * whether to run they are one situation: there is no credential to run with.
 *
 * The value is resolved at import time and exported as a VALUE rather than a
 * function, so each `describe.skipIf` can read it synchronously. That is what
 * keeps the outcome a SKIP rather than a failing `beforeAll`, which is the whole
 * point of Requirement 17.12's placement: public CI holds no OpenAI secret and
 * must still go green.
 *
 * @module tests/fixtures/embedding/openai-live
 */

import type { EmbeddingItem } from '../../../packages/core/src/embedding/request.ts'
import type { EmbeddingCatalogModel } from '../../../packages/provider-http/src/transport/embedding-connection.ts'
import { openAiEmbeddingAdapter } from '../../../packages/provider-openai/src/embedding.ts'

/** Registry route the live adapter is addressed under. */
export const OPENAI_EMBEDDING_ROUTE = 'openai'

/** Model used when the environment names none. */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

/**
 * The route's declared embedding catalog.
 *
 * `compatibilityIdentity` is per MODEL LINE and carries the generation in the
 * string: `text-embedding-3-small` and `text-embedding-3-large` produce vectors
 * that are not comparable, and a future `-4` line would get its own identity even
 * at an unchanged width.
 *
 * `dimensions` lists the widths the `3-*` lines accept. Declaring them is what
 * makes the `dimensions` parameter reachable on the wire at all — the adapter
 * refuses to send it against an `unknown` capability — and it is also what the
 * contract validates the returned width against.
 */
export const OPENAI_EMBEDDING_MODELS: readonly EmbeddingCatalogModel[] = Object.freeze([
  Object.freeze({
    id: 'text-embedding-3-small',
    name: 'Text Embedding 3 Small',
    dimensions: Object.freeze([256, 512, 768, 1024, 1536]),
    defaultDimensions: 1536,
    maxInputTokens: 8191,
    maxBatchItems: 2048,
    // No purpose parameter exists on `POST /embeddings`. Stated as the positive
    // negative claim rather than omitted, so a `purpose` never turns into an
    // invented text prefix.
    purposeHandling: 'unsupported' as const,
    compatibilityIdentity: 'openai:text-embedding-3-small',
  }),
  Object.freeze({
    id: 'text-embedding-3-large',
    name: 'Text Embedding 3 Large',
    dimensions: Object.freeze([256, 512, 1024, 2048, 3072]),
    defaultDimensions: 3072,
    maxInputTokens: 8191,
    maxBatchItems: 2048,
    purposeHandling: 'unsupported' as const,
    compatibilityIdentity: 'openai:text-embedding-3-large',
  }),
])

/**
 * The API key a live run would use, or `undefined` when there is none.
 *
 * Read once, at import time. `OPENAI_API_KEY` is the name the documentation and
 * the samples already use, so a developer who can run the samples can run this.
 */
export const openAiEmbeddingCredential: string | undefined = (() => {
  const key = process.env['OPENAI_API_KEY']
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : undefined
})()

/** Whether a live OpenAI embedding run is possible at all. */
export const openAiEmbeddingLive = openAiEmbeddingCredential !== undefined

/** The model this run uses; overridable for a self-hosted or mirrored endpoint. */
export const openAiEmbeddingModelId =
  process.env['OPENAI_EMBEDDING_MODEL'] ?? DEFAULT_OPENAI_EMBEDDING_MODEL

/** Endpoint base; set it to point the run at an OpenAI-compatible endpoint. */
export const openAiEmbeddingBaseUrl = process.env['OPENAI_EMBEDDING_BASE_URL']

/**
 * The catalog entry for {@link openAiEmbeddingModelId}, when the fixture declares
 * one.
 *
 * `undefined` for an env-supplied model this fixture knows nothing about — which
 * is not an error: the request still goes through, with every capability
 * `unknown`. It is the signal that width-specific assertions have no declared
 * number to be checked against and must not invent one.
 */
export const openAiEmbeddingModel: EmbeddingCatalogModel | undefined =
  OPENAI_EMBEDDING_MODELS.find(entry => entry.id === openAiEmbeddingModelId)

/**
 * Build the adapter a live run dispatches through.
 *
 * Goes through the real `openAiEmbeddingAdapter` — no injected `fetch` — because
 * the questions this fixture serves are about the ENDPOINT and about the adapter's
 * behaviour against it. `allowInsecureHttp` is opt-in and only consulted for a
 * cleartext base, so a typo'd `http://` URL cannot quietly send a key in the clear.
 *
 * The return type is inferred from the factory rather than annotated as
 * `EmbeddingAdapter`: `provider-openai` imports the contract through the package
 * entry point (`dist`), so an annotation naming the `src` class would be a
 * different nominal type to the compiler even though the shape is identical.
 * @returns the adapter, bound to the resolved credential and endpoint.
 */
export function liveOpenAiEmbeddingAdapter(): ReturnType<typeof openAiEmbeddingAdapter> {
  if (openAiEmbeddingCredential === undefined) {
    throw new Error('no OPENAI_API_KEY; the suite should have skipped')
  }
  return openAiEmbeddingAdapter({
    apiKey: openAiEmbeddingCredential,
    models: OPENAI_EMBEDDING_MODELS,
    ...(openAiEmbeddingBaseUrl === undefined ? {} : { baseUrl: openAiEmbeddingBaseUrl }),
    ...(process.env['OPENAI_EMBEDDING_ALLOW_INSECURE_HTTP'] === '1'
      ? { allowInsecureHttp: true }
      : {}),
  })
}

/**
 * One text item carrying an explicit logical index.
 *
 * The index is the caller's, not a position: the live spec passes sparse,
 * unordered indexes so a mapping that used the batch position instead cannot pass
 * by coincidence.
 * @param index - the item's index in the logical call.
 * @param text - the text to embed, sent verbatim.
 * @returns the item.
 */
export function embeddingItem(index: number, text: string): EmbeddingItem {
  return Object.freeze({
    index,
    contentParts: Object.freeze([Object.freeze({ type: 'text' as const, text })]),
  })
}

/**
 * Two sentences about one topic and one about another.
 *
 * Coarse on purpose. The cosine check that uses these is the only assertion in
 * the live spec that the vectors are MEANINGFUL rather than merely well-shaped,
 * and a subtle triple would turn it into a model-quality benchmark that fails on
 * calibration drift.
 */
export const SEMANTIC_CORPUS = Object.freeze({
  related: 'How do I create an index on a PostgreSQL table?',
  alsoRelated: 'Adding a database index to speed up SQL queries in Postgres.',
  unrelated: 'A recipe for slow-roasted lamb shoulder with rosemary and garlic.',
})

/**
 * Inputs of visibly different lengths, for the batch-ordering scenario.
 *
 * Uniform inputs would hide an endpoint that reordered by size or token count,
 * which is exactly what the index assertions exist to survive.
 */
export const BATCH_CORPUS: readonly string[] = Object.freeze([
  'alpha',
  'a moderately longer sentence about database indexes',
  'beta',
  'the quick brown fox jumps over the lazy dog, twice, for good measure',
  'gamma',
])

/**
 * Cosine similarity of two equal-width vectors.
 *
 * @param left - the first vector.
 * @param right - the second vector, same width.
 * @returns the similarity in `[-1, 1]`.
 */
export function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0
    dot += value * other
    leftNorm += value * value
    rightNorm += other * other
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/** Euclidean norm, for reporting whether the endpoint answers unit vectors. */
export function norm(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value * value
  return Math.sqrt(total)
}
