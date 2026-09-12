/**
 * Purpose of an embedding input, declared once at the shared API.
 *
 * @module ai-agent-sdk/core/embedding/purpose
 */

/**
 * Why an input is being embedded.
 *
 * Exactly two values. Purpose is REQUIRED on every `embed()`/`embedMany()` call,
 * and translating it to a provider mechanism belongs entirely to the adapter.
 */
export type EmbeddingPurpose = 'retrieval-query' | 'retrieval-document'

/**
 * How one route expresses {@link EmbeddingPurpose} on the wire.
 *
 * A route whose handling is `unknown` or `{ kind: 'none' }` gets the text sent
 * verbatim: an adapter never adds a prefix the provider has not documented.
 */
export type EmbeddingPurposeHandling =
  /** Provider has a dedicated wire parameter, for example Gemini `taskType`. */
  | { readonly kind: 'wire-parameter'; readonly parameter: string }
  /** Provider requires an adapter-inserted prefix, per provider documentation. */
  | { readonly kind: 'adapter-prefix'; readonly documented: true }
  /** Provider exposes no mechanism; the adapter does NOT invent a prefix. */
  | { readonly kind: 'none' }
