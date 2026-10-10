import type { HttpProviderOptions } from './http-options.ts'
import { authSchemesOf } from './auth.ts'
import {
  boundedCatalog,
  positiveFinite,
  positiveSafeInteger,
  nonNegativeFinite,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_CATALOG_STALE_TTL_MS,
  DEFAULT_CATALOG_FAILURE_BACKOFF_MS,
  DEFAULT_MAX_CATALOG_MODELS,
  DEFAULT_MAX_CATALOG_BYTES,
} from './configuration-support.ts'

export function snapshotConfiguration<Dialect extends object>(
  options: HttpProviderOptions<Dialect>,
): HttpProviderOptions<Dialect> {
  const maxCatalogModels = positiveSafeInteger(
    options.maxCatalogModels ?? DEFAULT_MAX_CATALOG_MODELS,
    'maxCatalogModels',
  )
  const maxCatalogBytes = positiveSafeInteger(
    options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    'maxCatalogBytes',
  )
  const models = options.models === undefined
    ? undefined
    : boundedCatalog(options.models, maxCatalogModels, maxCatalogBytes)
  return Object.freeze({
    ...options,
    catalogTtlMs: positiveFinite(options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS, 'catalogTtlMs'),
    catalogStaleTtlMs: nonNegativeFinite(
      options.catalogStaleTtlMs ?? DEFAULT_CATALOG_STALE_TTL_MS,
      'catalogStaleTtlMs',
    ),
    catalogFailureBackoffMs: nonNegativeFinite(
      options.catalogFailureBackoffMs ?? DEFAULT_CATALOG_FAILURE_BACKOFF_MS,
      'catalogFailureBackoffMs',
    ),
    maxCatalogModels,
    maxCatalogBytes,
    auth: Object.freeze(authSchemesOf(options.auth).map(scheme => Object.freeze({ ...scheme }))),
    ...(models === undefined ? {} : { models }),
    ...snapshotOptionalRecords(options),
  })
}

function snapshotOptionalRecords<Dialect extends object>(options: HttpProviderOptions<Dialect>) {
  return {
      ...(options.headers === undefined || typeof options.headers === 'function'
        ? {}
        : { headers: Object.freeze({ ...options.headers }) }),
      ...(options.baseHeaders === undefined ? {} : { baseHeaders: Object.freeze({ ...options.baseHeaders }) }),
      ...(options.query === undefined || typeof options.query === 'function'
        ? {}
        : { query: Object.freeze({ ...options.query }) }),
      ...(options.body === undefined ? {} : { body: Object.freeze({ ...options.body }) }),
  }
}
