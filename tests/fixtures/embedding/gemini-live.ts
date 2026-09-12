/**
 * Credential guard and shared inputs for the Gemini embedding live spec.
 *
 * ## Why a guard at all
 *
 * Requirement 17.12 puts live provider tests in `tests/integration/` behind
 * `vitest.integration.config.ts`, and the scaffolding — this fixture, the spec, and
 * the skip — is the MANDATORY half of that. The run against the real endpoint is the
 * optional half, because it needs a secret public CI does not hold. So with no key
 * present the spec SKIPS itself rather than failing: a red suite on a machine that
 * was never given a credential says nothing about this SDK.
 *
 * The guard is a synchronously-readable VALUE, not a function, because
 * `describe.skipIf` runs during collection. A `beforeAll` that threw would surface as
 * a failure, which is the opposite of the intent.
 *
 * ## Why `GEMINI_KEY`
 *
 * That is the variable the repository already uses for a real Gemini call — see
 * `tests/integration/document-input.spec.ts`, which reads `GEMINI_KEY` and
 * `GEMINI_MODEL`. A second spelling invented here would let a developer export a key
 * the other live spec cannot see, so this file reads the same name and adds only an
 * optional model override.
 *
 * ## Why the corpus lives here instead of in the spec
 *
 * The semantic scenario needs text whose relatedness is obvious enough to assert an
 * ORDERING on, not a threshold. Keeping the three sentences in one place makes it
 * explicit that the pairing — two about the same topic, one about something else — is
 * the fixture's contract, and lets a batching scenario reuse inputs of visibly
 * different lengths without restating them.
 *
 * @module tests/fixtures/embedding/gemini-live
 */

/** The key a live run needs, or `undefined` when none was exported. */
const key = process.env.GEMINI_KEY?.trim()

/**
 * The credential the spec runs with, resolved at import time.
 *
 * An empty or whitespace-only value is treated as absent: to a suite deciding
 * whether to run, `GEMINI_KEY=` and no `GEMINI_KEY` at all are one situation.
 */
export const geminiLiveKey: string | undefined = key !== undefined && key.length > 0
  ? key
  : undefined

/** Whether a live Gemini embedding run is possible at all. */
export const geminiEmbeddingLive: boolean = geminiLiveKey !== undefined

/**
 * The model the live run uses.
 *
 * Overridable so an account with access to a newer generation can point the same
 * spec at it; the default is the one entry `GEMINI_EMBEDDING_MODELS` declares.
 */
export const GEMINI_LIVE_EMBEDDING_MODEL: string =
  process.env.GEMINI_EMBEDDING_MODEL?.trim() ?? 'gemini-embedding-001'

/** Route key the plugin claims for the live run. */
export const GEMINI_LIVE_ROUTE = 'gemini-embedding'

/** Native width of `gemini-embedding-001`, per the declared catalog. */
export const GEMINI_NATIVE_DIMENSIONS = 3072

/**
 * A narrower width the model offers.
 *
 * A declared alternative rather than an arbitrary number, so the request exercises
 * `outputDimensionality` plus the profile's recorded `l2-renormalize` step instead of
 * probing whether an undeclared width happens to be accepted.
 */
export const GEMINI_REDUCED_DIMENSIONS = 768

/** Bound on one live request; the endpoint is slow enough to need a generous one. */
export const GEMINI_LIVE_TIMEOUT_MS = 60_000

/**
 * Two sentences about one topic and one about another.
 *
 * Coarse on purpose. A subtle triple would turn the cosine check into a benchmark of
 * this model's calibration, which drifts; a coarse one keeps the assertion a claim
 * about the vectors carrying MEANING.
 */
export const GEMINI_SEMANTIC_CORPUS = Object.freeze({
  related: 'How do I create an index on a PostgreSQL table?',
  alsoRelated: 'Adding a database index to speed up SQL queries in Postgres.',
  unrelated: 'A recipe for slow-roasted lamb shoulder with rosemary and garlic.',
})

/**
 * Inputs of visibly different lengths, for the ordering scenario.
 *
 * The lengths matter: `batchEmbedContents` answers positionally with no index of its
 * own, so uniform inputs would hide a reordering by size or token count if the
 * endpoint ever did one.
 */
export const GEMINI_BATCH_INPUTS: readonly string[] = Object.freeze([
  'alpha',
  'a moderately longer sentence about database indexes',
  'beta',
  'the quick brown fox jumps over the lazy dog, twice, for good measure',
  'gamma',
])

/**
 * Euclidean length of a vector.
 *
 * @param values - the components.
 * @returns the L2 norm.
 */
export function l2Norm(values: readonly number[]): number {
  let sum = 0
  for (const value of values) sum += value * value
  return Math.sqrt(sum)
}

/**
 * Cosine similarity of two equal-width vectors.
 *
 * @param left - the first vector.
 * @param right - the second vector, of the same width.
 * @returns the similarity, in `[-1, 1]`.
 */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error(`cosine needs equal widths, got ${String(left.length)} and ${String(right.length)}`)
  }
  let dot = 0
  for (const [index, value] of left.entries()) dot += value * (right[index] as number)
  return dot / (l2Norm(left) * l2Norm(right))
}
