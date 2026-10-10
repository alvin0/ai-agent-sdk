import type { ProviderCatalogModel } from '@alvin0/ai-agent-sdk-provider-http'

/** Path of the catalog surface, relative to the pinned Copilot base URL. */
export const COPILOT_CATALOG_PATH = '/models'

/** Maximum raw catalog bytes when the caller configures none. */
export const COPILOT_DEFAULT_MAX_CATALOG_BYTES = 4 * 1024 * 1024

/** Maximum catalog entries accepted when the caller configures none. */
export const COPILOT_DEFAULT_MAX_CATALOG_MODELS = 2_048

/** Maximum catalog response chunks accepted when the caller configures none. */
export const COPILOT_DEFAULT_MAX_CATALOG_CHUNKS = 10_000

/** Catalog request deadline when the caller configures none. */
export const COPILOT_DEFAULT_CATALOG_TIMEOUT_MS = 30_000

/**
 * Which endpoint a generation model is dispatched to.
 *
 * Declared HERE rather than in `./router.ts`, where the router's own types live,
 * for one structural reason: `./router.ts` imports {@link CopilotGenerationModel}
 * from this module, so the dependency edge already runs router → catalog. Putting
 * the endpoint union in the router would make it run both ways, which the repo's
 * source-ownership check forbids and which nothing here needs. `./router.ts`
 * re-exports this type, so the router remains the module a reader goes to for
 * endpoint selection.
 */
export type CopilotEndpoint = 'responses' | 'chat-completions'

/**
 * One entry of `GET /models`, typed as UNKNOWN at every leaf on purpose.
 *
 * `unknown` rather than the shape the endpoint documents, because this is the one
 * place a response that changed shape arrives: a declared `string` would let a
 * number flow into a catalog field and fail somewhere else entirely.
 */
export interface WireCopilotModel {
  readonly id?: unknown
  readonly name?: unknown
  readonly capabilities?: {
    readonly type?: unknown
    readonly family?: unknown
    readonly limits?: {
      readonly max_context_window_tokens?: unknown
      readonly max_output_tokens?: unknown
      readonly max_inputs?: unknown
    }
    readonly supports?: Readonly<Record<string, unknown>>
  }
  readonly vision?: unknown
  readonly model_picker_enabled?: unknown
}

/** Why an entry was left out of both catalogs. */
export type CopilotOmitReason =
  /** capabilities.type is not one of the recognized values. */
  | 'capability-type-unrecognized'
  /** No usable id. */
  | 'model-id-missing'

/** One entry that was dropped, with the reason an operator needs to see it. */
export interface CopilotOmittedModel {
  /** The entry's id, or `''` when it had none — the reason says which. */
  readonly id: string
  /** Why it was dropped. */
  readonly reason: CopilotOmitReason
}

/** A generation model, plus whatever the catalog disclosed about its endpoint. */
export interface CopilotGenerationModel {
  /** The SDK catalog model, handed to `provider-http` unchanged. */
  readonly model: ProviderCatalogModel
  /**
   * The endpoint the catalog disclosed, when it disclosed one.
   *
   * `undefined` means UNKNOWN, not "not supported". The router handles those two
   * states differently (Requirement 8.6).
   */
  readonly declaredEndpoint: CopilotEndpoint | undefined
}

/**
 * An embedding model, carrying only the facts the catalog stated.
 *
 * Deliberately NOT a {@link ProviderCatalogModel}: an embedding model has no
 * context window or output cap to report, and `Copilot_Embedding_Adapter` needs
 * different facts (batch ceiling, whether a requested dimension count is
 * honoured). Every field but `id` is optional because every one of them is absent
 * from some real entry.
 */
export interface CopilotEmbeddingModel {
  /** Wire model id, passed to the endpoint verbatim. */
  readonly id: string
  /** Display label, when the catalog supplied one. */
  readonly name?: string
  /** Model family, when disclosed; embedding compatibility identity is derived from it. */
  readonly family?: string
  /** Token ceiling for one input, from `limits.max_context_window_tokens`. */
  readonly maxInputTokens?: number
  /** Ceiling on inputs per request, from `limits.max_inputs`. */
  readonly maxInputs?: number
  /** Whether `supports.dimensions` was stated, and what it said. */
  readonly supportsDimensions?: boolean
}

/** The result of one discovery, partitioned. */
export interface CopilotCatalogSnapshot {
  /** Models usable for generation, each with its preliminary endpoint disclosure. */
  readonly generation: readonly CopilotGenerationModel[]
  /** Models usable for embedding. */
  readonly embedding: readonly CopilotEmbeddingModel[]
  /** Dropped entries with their reasons — these go to observation, not to a catalog. */
  readonly omitted: readonly CopilotOmittedModel[]
}

/** Resolved bounds for one catalog read. Every field is a bound, never "unlimited". */
export interface CopilotCatalogLimits {
  /** Maximum raw response bytes. */
  readonly maxBytes: number
  /** Maximum entries accepted before the response is called malformed. */
  readonly maxModels: number
  /** Maximum response chunks. */
  readonly maxChunks: number
  /** Deadline for the catalog request AND its body read. */
  readonly timeoutMs: number
  /** Permit an `http:` base URL for a trusted local test endpoint. */
  readonly allowInsecureHttp?: boolean
}

/**
 * The caller-facing catalog options, in the spelling `CopilotProviderOptions` uses.
 *
 * Split into two groups on purpose. The four `max*`/`timeout` values bound ONE
 * read and are resolved here by {@link resolveCopilotCatalogLimits}. The three
 * cache values (TTL, stale TTL, failure backoff) bound how often reads happen at
 * all, and `provider-http` already owns that policy — {@link
 * copilotCatalogCacheOptions} forwards them without a default, so an unset option
 * keeps the runtime's own default instead of this package pinning a second one
 * (Requirement 8.7).
 */
export interface CopilotCatalogOptions {
  /** Maximum raw catalog bytes. Defaults to {@link COPILOT_DEFAULT_MAX_CATALOG_BYTES}. */
  readonly maxCatalogBytes?: number
  /** Maximum catalog entries. Defaults to {@link COPILOT_DEFAULT_MAX_CATALOG_MODELS}. */
  readonly maxCatalogModels?: number
  /** Maximum catalog response chunks. Defaults to {@link COPILOT_DEFAULT_MAX_CATALOG_CHUNKS}. */
  readonly maxCatalogChunks?: number
  /** Catalog request deadline. Defaults to {@link COPILOT_DEFAULT_CATALOG_TIMEOUT_MS}. */
  readonly catalogTimeoutMs?: number
  /** How long a discovered catalog stays fresh. */
  readonly catalogTtlMs?: number
  /** How long a stale catalog may still be served while a refresh is attempted. */
  readonly catalogStaleTtlMs?: number
  /** How long to wait before retrying discovery after it failed. */
  readonly catalogFailureBackoffMs?: number
  /** Permit an `http:` base URL for a trusted local test endpoint. */
  readonly allowInsecureHttp?: boolean
}
