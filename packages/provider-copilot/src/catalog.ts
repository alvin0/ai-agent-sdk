/**
 * `Copilot_Catalog`: read `GET /models`, then PARTITION what came back.
 *
 * Discovery is the right default for this surface (Requirement 8.1): which models
 * an account may call depends on its plan, on its organisation's policy, and on
 * the editor identity the request presents, so no hardcoded list is correct for
 * two accounts at once. Passing `models` explicitly skips discovery entirely
 * (Requirement 8.5) — that decision belongs to the adapter, which simply does not
 * call this module in that case.
 *
 * ## Two levels of wrongness, two different answers
 *
 * The defensive read runs in a fixed order, and the order IS the contract:
 *
 * ```text
 * 1. redirect (every shape)                       ⇒ COPILOT_REDIRECT_REJECTED
 * 2. declared content-length over the limit       ⇒ RangeError, body cancelled
 * 3. accumulated bytes/chunks over the limit      ⇒ RangeError, reader cancelled
 * 4. body is not JSON, root is not an object,
 *    or `data` is not an array                    ⇒ COPILOT_CATALOG_MALFORMED
 * 5. entry count over maxCatalogModels            ⇒ COPILOT_CATALOG_MALFORMED
 * 6. entry: id is not a non-empty string          ⇒ omitted 'model-id-missing'
 * 7. entry: capabilities.type unrecognized        ⇒ omitted 'capability-type-unrecognized'
 * ```
 *
 * Steps 4 and 5 are STRUCTURAL, and a structural mismatch is an error rather than
 * a starting point for a guess (Requirement 8.8): a model list inferred from a
 * body this SDK could not read is a list nobody can be held to. Steps 6 and 7 are
 * at ENTRY level, and there the entry is dropped while the rest of the catalog
 * survives — one unfamiliar entry must not kill every model that still works.
 *
 * Dropping rather than listing-with-a-flag is the same judgement in the other
 * direction (Requirements 9.4, 9.5): listing a model this SDK cannot dispatch is
 * worse than not listing it, because it shows up in a selector and then fails at
 * call time, far from the cause.
 *
 * ## Metadata is translated, never invented
 *
 * Every field of {@link ProviderCatalogModel} is filled only from a field the
 * endpoint actually supplied (Requirement 8.4). The trap is
 * `inputModalities`: with no vision signal at all the field is ABSENT, NOT
 * `['text']`. An explicit list without `image` is a NEGATIVE claim the registry
 * acts on — it projects images to text — so inventing `['text']` would silently
 * strip images from every request to a model that may well accept them. Absent
 * means unknown, and unknown is what the endpoint said.
 *
 * `declaredEndpoint` follows the same rule and stays `undefined` when the catalog
 * discloses nothing. `undefined` is NOT "not supported"; the router treats the two
 * states differently (Requirement 8.6).
 *
 * ## The catalog is advisory
 *
 * `omitted` does not fail anything. A dispatched request to an omitted id still
 * goes out — it just takes the router's default branch — and a real error from the
 * endpoint remains the final word whenever metadata and behaviour disagree
 * (Requirement 8.6).
 *
 * @module ai-agent-sdk/providers/copilot/catalog
 */

import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import type { ModelModality } from '@alvin0/ai-agent-sdk-core/provider'
import type {
  ProviderCatalogModel,
  RuntimeModelDiscoveryContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import { COPILOT_BASE_URL } from './common/identity.ts'
import { COPILOT_ERROR_CODES } from './errors.ts'
import {
  copilotFetch,
  copilotUrl,
  issuerOf,
  positiveSafeInteger,
  readCopilotResponseText,
} from './common/http.ts'

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
interface WireCopilotModel {
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

/**
 * Resolve the per-read bounds, rejecting a value that cannot bound anything.
 *
 * Validation happens here rather than at the read, so a `0` or a `NaN` in the
 * configuration is a construction-time error instead of a silently disabled limit
 * discovered under load (Requirement 8.2).
 * @param options - the caller's catalog options.
 * @returns the four resolved bounds plus the insecure-HTTP opt-in.
 * @throws RangeError when a configured bound is not a positive safe integer.
 */
export function resolveCopilotCatalogLimits(
  options: CopilotCatalogOptions = {},
): CopilotCatalogLimits {
  return Object.freeze({
    maxBytes: positiveSafeInteger(
      options.maxCatalogBytes ?? COPILOT_DEFAULT_MAX_CATALOG_BYTES,
      'maxCatalogBytes',
    ),
    maxModels: positiveSafeInteger(
      options.maxCatalogModels ?? COPILOT_DEFAULT_MAX_CATALOG_MODELS,
      'maxCatalogModels',
    ),
    maxChunks: positiveSafeInteger(
      options.maxCatalogChunks ?? COPILOT_DEFAULT_MAX_CATALOG_CHUNKS,
      'maxCatalogChunks',
    ),
    timeoutMs: positiveSafeInteger(
      options.catalogTimeoutMs ?? COPILOT_DEFAULT_CATALOG_TIMEOUT_MS,
      'catalogTimeoutMs',
    ),
    ...(options.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: options.allowInsecureHttp }),
  })
}

/**
 * Forward the three cache-policy options, and only the ones that were set.
 *
 * A conditional spread rather than defaults: `provider-http` owns catalog caching,
 * and a default written here would override the runtime's own without anyone
 * asking for it (Requirement 8.7).
 * @param options - the caller's catalog options.
 * @returns an object carrying only the cache options the caller supplied.
 */
export function copilotCatalogCacheOptions(options: CopilotCatalogOptions = {}): {
  readonly catalogTtlMs?: number
  readonly catalogStaleTtlMs?: number
  readonly catalogFailureBackoffMs?: number
} {
  return {
    ...(options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs }),
    ...(options.catalogStaleTtlMs === undefined
      ? {}
      : { catalogStaleTtlMs: options.catalogStaleTtlMs }),
    ...(options.catalogFailureBackoffMs === undefined
      ? {}
      : { catalogFailureBackoffMs: options.catalogFailureBackoffMs }),
  }
}

/**
 * Read `GET {baseUrl}/models` and partition it.
 *
 * The base URL is re-pinned here from `context.baseUrl` rather than trusted as a
 * string: the catalog is the first Copilot call an adapter makes, and a pin
 * compared before dispatch is the only check that runs before the resolved
 * `Authorization` header leaves the process.
 * @param context - the discovery context `provider-http` supplies: base URL,
 *   already-resolved headers, and the operation's signal.
 * @param limits - bounds from {@link resolveCopilotCatalogLimits}.
 * @param fetchImpl - HTTP implementation, injected for tests and non-browser runtimes.
 * @returns the partitioned snapshot; an empty one when the endpoint answered a
 *   non-2xx status, because a catalog that could not be fetched is advisory too.
 * @throws AgentSdkError with `COPILOT_REDIRECT_REJECTED` on any redirect shape, or
 *   `COPILOT_CATALOG_MALFORMED` when the response is the wrong shape structurally.
 * @throws RangeError when the response exceeds a configured bound.
 */
export async function discoverCopilotModels(
  context: RuntimeModelDiscoveryContext,
  limits: CopilotCatalogLimits,
  fetchImpl: typeof globalThis.fetch,
): Promise<CopilotCatalogSnapshot> {
  const pinned = issuerOf('baseUrl', context.baseUrl.href, COPILOT_BASE_URL, {
    ...(limits.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureIssuer: limits.allowInsecureHttp }),
  })
  const url = copilotUrl(pinned, COPILOT_CATALOG_PATH)
  const http = {
    signal: context.signal,
    fetch: fetchImpl,
    requestTimeoutMs: limits.timeoutMs,
    maxResponseBytes: limits.maxBytes,
    maxResponseChunks: limits.maxChunks,
    ...(limits.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureIssuer: limits.allowInsecureHttp }),
  }
  const response = await copilotFetch(
    { pinned, url, operation: 'model catalog', init: { method: 'GET', headers: context.headers } },
    http,
  )
  if (!response.ok) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined)
    return EMPTY_SNAPSHOT
  }
  const text = await readCopilotResponseText(response, http)
  return partitionCopilotCatalog(parseCatalogBody(text), limits.maxModels)
}

/**
 * Partition an already-read catalog body.
 *
 * Exported separately from the fetch so the partition is testable — and readable —
 * as what it is: a pure function from a parsed body to three lists.
 * @param body - the parsed root object of the catalog response.
 * @param maxModels - entry-count ceiling; exceeding it is structural, not per-entry.
 * @returns the partitioned snapshot.
 * @throws AgentSdkError with `COPILOT_CATALOG_MALFORMED` when `data` is not an
 *   array or holds more than `maxModels` entries.
 */
export function partitionCopilotCatalog(
  body: Record<string, unknown>,
  maxModels: number,
): CopilotCatalogSnapshot {
  const data = body.data
  if (!Array.isArray(data)) {
    throw malformed('Copilot model catalog `data` must be an array')
  }
  if (data.length > maxModels) {
    throw malformed(`Copilot model catalog exceeds the ${maxModels}-model limit`)
  }
  const generation: CopilotGenerationModel[] = []
  const embedding: CopilotEmbeddingModel[] = []
  const omitted: CopilotOmittedModel[] = []
  for (const candidate of data as readonly unknown[]) {
    const entry: WireCopilotModel = isRecord(candidate) ? candidate as WireCopilotModel : {}
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id.length === 0) {
      omitted.push({ id, reason: 'model-id-missing' })
      continue
    }
    const type = entry.capabilities?.type
    if (type === 'chat') {
      generation.push(generationModel(id, entry))
      continue
    }
    if (type === 'embeddings') {
      embedding.push(embeddingModel(id, entry))
      continue
    }
    omitted.push({ id, reason: 'capability-type-unrecognized' })
  }
  return Object.freeze({
    generation: Object.freeze(generation),
    embedding: Object.freeze(embedding),
    omitted: Object.freeze(omitted),
  })
}

/** The snapshot returned when there is nothing to report, frozen and shared. */
const EMPTY_SNAPSHOT: CopilotCatalogSnapshot = Object.freeze({
  generation: Object.freeze([]),
  embedding: Object.freeze([]),
  omitted: Object.freeze([]),
})

/** Modalities claimed when — and only when — a vision signal was actually present. */
const TEXT_AND_IMAGE: readonly ModelModality[] = Object.freeze(['text', 'image'])

/**
 * Translate one `type: 'chat'` entry, filling only what the endpoint supplied.
 *
 * `name` is not defaulted to `id`: a display label the endpoint did not send is a
 * label this layer would be inventing, and the layer that renders a selector
 * already falls back to the id.
 */
function generationModel(id: string, entry: WireCopilotModel): CopilotGenerationModel {
  const limits = entry.capabilities?.limits
  const supports = entry.capabilities?.supports
  const vision = entry.vision === true || supports?.vision === true
  const contextWindow = positiveInteger(limits?.max_context_window_tokens)
  const maxTokens = positiveInteger(limits?.max_output_tokens)
  return Object.freeze({
    model: Object.freeze({
      id,
      ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      // No vision signal ⇒ ABSENT. `['text']` would be a negative claim about
      // image input that the endpoint never made.
      ...(vision ? { inputModalities: TEXT_AND_IMAGE } : {}),
    }),
    declaredEndpoint: declaredEndpointOf(supports),
  })
}

/** Translate one `type: 'embeddings'` entry, under the same fill-only-what-was-said rule. */
function embeddingModel(id: string, entry: WireCopilotModel): CopilotEmbeddingModel {
  const capabilities = entry.capabilities
  const limits = capabilities?.limits
  const maxInputTokens = positiveInteger(limits?.max_context_window_tokens)
  const maxInputs = positiveInteger(limits?.max_inputs)
  const dimensions = capabilities?.supports?.dimensions
  return Object.freeze({
    id,
    ...(typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {}),
    ...(typeof capabilities?.family === 'string' && capabilities.family.length > 0
      ? { family: capabilities.family }
      : {}),
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxInputs === undefined ? {} : { maxInputs }),
    ...(typeof dimensions === 'boolean' ? { supportsDimensions: dimensions } : {}),
  })
}

/**
 * Read the endpoint disclosure, and only a disclosure.
 *
 * `supports.responses === true` says `/responses`; `false` says `/chat/completions`
 * — the endpoint stated something either way. Anything else, including the field
 * being absent or holding a non-boolean, is UNKNOWN and stays `undefined`, which
 * is a different state from "not supported" (Requirement 8.6).
 */
function declaredEndpointOf(
  supports: Readonly<Record<string, unknown>> | undefined,
): CopilotEndpoint | undefined {
  const responses = supports?.responses
  if (responses === true) return 'responses'
  if (responses === false) return 'chat-completions'
  return undefined
}

/**
 * Parse the catalog body, treating an unreadable body as structural.
 *
 * Both failures land on the same code because they are the same problem: the
 * response is not a catalog, and there is nothing here to guess a model list from
 * (Requirement 8.8).
 */
function parseCatalogBody(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw malformed('Copilot model catalog is not valid JSON', error)
  }
  if (!isRecord(parsed)) {
    throw malformed('Copilot model catalog must be a JSON object')
  }
  return parsed
}

/** Accept a numeric metadata field only when it can serve as a capacity. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A JSON object, excluding arrays — `data` being at the root is not a catalog. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string, cause?: unknown): AgentSdkError {
  return new AgentSdkError(
    message,
    COPILOT_ERROR_CODES.CATALOG_MALFORMED,
    cause === undefined ? undefined : { cause },
  )
}
