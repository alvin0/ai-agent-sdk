/**
 * Fixed inputs and sentinels the embedding harness drives every case with.
 *
 * Values are constants rather than fixture-supplied so two providers are held to
 * the same corpus, and so the privacy check has something it KNOWS must never
 * appear in a trace: every input carries {@link EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel},
 * which makes "the trace carries no raw document content" a substring test rather
 * than an inspection (Requirement 17.10).
 *
 * @module ai-agent-sdk/testkit/provider/embedding/config
 */

export const EMBEDDING_CONFORMANCE_DEFAULTS = Object.freeze({
  /** Inputs of a plain `Logical_Call`. */
  inputCount: 4,
  /** Inputs of the batching, abort and retry scenarios; enough to need several batches. */
  corpusCount: 12,
  /** Marker embedded in every input; must never reach a trace or an error. */
  contentSentinel: 'EMBEDDING_CONFORMANCE_CONTENT/PRIVATE~SENTINEL%',
  /** Security scope of the cache scenario. */
  cacheScope: 'embedding-conformance/tenant-a',
  /** A second scope, which must produce different cache keys for identical inputs. */
  alternateCacheScope: 'embedding-conformance/tenant-b',
  /** Default purpose; the cache scenario also uses the query purpose. */
  purpose: 'retrieval-document',
  alternatePurpose: 'retrieval-query',
} as const)

/**
 * The texts of one case, deterministic and sentinel-bearing.
 *
 * `count` items, each long enough that its full-precision vector values and its
 * own text are both distinctive, so a privacy substring test cannot pass by luck.
 */
export function embeddingConformanceInputs(count: number, label: string): readonly string[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => (
    `${EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel} ${label} document ${index} `
    + `body-${index}-${'payload '.repeat(2)}${index}`
  )))
}
