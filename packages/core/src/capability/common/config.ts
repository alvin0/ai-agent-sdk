/** Shared resource bounds for inert capability metadata; no model/provider defaults. */
export const COMPOSITION_LIMITS = Object.freeze({
  providers: 128,
  exporters: 128,
  routesPerProvider: 128,
  identityBytes: 256,
  displayNameBytes: 1_024,
  modelIdBytes: 1_024,
})

export const MODEL_BINDING_ERROR_CODES = Object.freeze({
  INVALID: 'MODEL_TARGET_INVALID',
  UNKNOWN_ROUTE: 'MODEL_ROUTE_UNAVAILABLE',
  MISSING_DEFAULT: 'MODEL_DEFAULT_MISSING',
  AMBIGUOUS_DEFAULT: 'MODEL_DEFAULT_AMBIGUOUS',
})
