import { timeoutValue } from '../../platform/config.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { boundedText, objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import { MODEL_CATALOG_DEFAULTS, MODEL_CATALOG_ERROR_CODES } from './config.ts'
import type { CapturedModelCatalogOptions, ModelCatalogPolicy } from './types.ts'

const OPTION_KEYS = new Set(['signal', 'refresh'])

export function captureCatalogRoute(value: unknown): string {
  try { return boundedText(value, COMPOSITION_LIMITS.identityBytes) }
  catch { throw new TypeError(MODEL_CATALOG_ERROR_CODES.routeUnavailable) }
}

export function captureCatalogOptions(value: unknown): CapturedModelCatalogOptions {
  if (value === undefined) return Object.freeze({ refresh: 'if-stale' })
  try {
    const source = objectValue(value)
    if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !OPTION_KEYS.has(key))) throw new Error()
    const signal = optionalAbortSignal(ownData(source, 'signal', false))
    const refresh = ownData(source, 'refresh', false) ?? 'if-stale'
    if (refresh !== 'if-stale' && refresh !== 'force') throw new Error()
    return Object.freeze({ refresh, ...(signal === undefined ? {} : { signal }) })
  } catch { throw new TypeError(MODEL_CATALOG_ERROR_CODES.invalidOptions) }
}

export function resolveCatalogPolicy(input: ModelCatalogPolicy = {}): Required<ModelCatalogPolicy> {
  const freshTtlMs = timeoutValue(input.freshTtlMs ?? MODEL_CATALOG_DEFAULTS.freshTtlMs, true)
  const staleTtlMs = timeoutValue(input.staleTtlMs ?? MODEL_CATALOG_DEFAULTS.staleTtlMs, true)
  const failureRetryMs = timeoutValue(input.failureRetryMs ?? MODEL_CATALOG_DEFAULTS.failureRetryMs)
  const maxFailureRetryMs = timeoutValue(input.maxFailureRetryMs ?? MODEL_CATALOG_DEFAULTS.maxFailureRetryMs)
  if (failureRetryMs > maxFailureRetryMs) throw new RangeError('Model catalog retry base exceeds its cap')
  return Object.freeze({ freshTtlMs, staleTtlMs, failureRetryMs, maxFailureRetryMs })
}
