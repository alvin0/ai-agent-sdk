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
import type { RuntimeModelDiscoveryContext } from '@alvin0/ai-agent-sdk-provider-http'
import { COPILOT_BASE_URL } from './common/identity.ts'
import { COPILOT_ERROR_CODES } from './errors.ts'
import { copilotFetch, copilotUrl, issuerOf, readCopilotResponseText } from './common/http.ts'
import { COPILOT_CATALOG_PATH } from './catalog-types.ts'
import type {
  WireCopilotModel, CopilotOmittedModel, CopilotGenerationModel, CopilotEmbeddingModel,
  CopilotCatalogSnapshot, CopilotCatalogLimits,
} from './catalog-types.ts'
export {
  COPILOT_CATALOG_PATH, COPILOT_DEFAULT_MAX_CATALOG_BYTES, COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  COPILOT_DEFAULT_MAX_CATALOG_CHUNKS, COPILOT_DEFAULT_CATALOG_TIMEOUT_MS,
} from './catalog-types.ts'
export type {
  CopilotEndpoint, CopilotOmitReason, CopilotOmittedModel, CopilotGenerationModel, CopilotEmbeddingModel,
  CopilotCatalogSnapshot, CopilotCatalogLimits, CopilotCatalogOptions,
} from './catalog-types.ts'
export { resolveCopilotCatalogLimits, copilotCatalogCacheOptions } from './catalog-options.ts'
import { generationModel, embeddingModel } from './catalog-models.ts'

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
export const EMPTY_SNAPSHOT: CopilotCatalogSnapshot = Object.freeze({
  generation: Object.freeze([]),
  embedding: Object.freeze([]),
  omitted: Object.freeze([]),
})

/**
 * Parse the catalog body, treating an unreadable body as structural.
 *
 * Both failures land on the same code because they are the same problem: the
 * response is not a catalog, and there is nothing here to guess a model list from
 * (Requirement 8.8).
 */
export function parseCatalogBody(text: string): Record<string, unknown> {
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

/** A JSON object, excluding arrays — `data` being at the root is not a catalog. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function malformed(message: string, cause?: unknown): AgentSdkError {
  return new AgentSdkError(
    message,
    COPILOT_ERROR_CODES.CATALOG_MALFORMED,
    cause === undefined ? undefined : { cause },
  )
}
