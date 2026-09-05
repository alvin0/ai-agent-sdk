export const MODEL_CATALOG_DEFAULTS = Object.freeze({
  freshTtlMs: 5 * 60_000,
  staleTtlMs: 0,
  failureRetryMs: 5_000,
  maxFailureRetryMs: 60_000,
})

export const MODEL_CATALOG_ERROR_CODES = Object.freeze({
  routeUnavailable: 'MODEL_CATALOG_ROUTE_UNAVAILABLE',
  refreshUnavailable: 'MODEL_CATALOG_UNAVAILABLE',
  invalidOptions: 'MODEL_CATALOG_OPTIONS_INVALID',
})
