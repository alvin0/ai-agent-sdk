import { positiveSafeInteger } from './common/http.ts'
import {
  COPILOT_DEFAULT_MAX_CATALOG_BYTES, COPILOT_DEFAULT_MAX_CATALOG_MODELS, COPILOT_DEFAULT_MAX_CATALOG_CHUNKS,
  COPILOT_DEFAULT_CATALOG_TIMEOUT_MS,
} from './catalog-types.ts'
import type { CopilotCatalogLimits, CopilotCatalogOptions } from './catalog-types.ts'

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
