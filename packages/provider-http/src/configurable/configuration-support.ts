import { detachedFrozen } from '@alvin0/ai-agent-sdk-core'
import { type ProviderCatalogModel } from '../base/http-adapter.ts'

export const DEFAULT_CATALOG_TTL_MS = 5 * 60 * 1_000
export const DEFAULT_CATALOG_STALE_TTL_MS = 0
export const DEFAULT_CATALOG_FAILURE_BACKOFF_MS = 5_000
export const DEFAULT_MAX_CATALOG_MODELS = 2_048
export const DEFAULT_MAX_CATALOG_BYTES = 4 * 1024 * 1024

export function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`)
  }
  return value
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

export function nonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`)
  }
  return value
}

export function staleCatalog(
  cached: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined,
  now: number,
  ttl: number,
  staleTtl: number,
): readonly ProviderCatalogModel[] {
  if (cached === undefined || now - cached.fetchedAt >= ttl + staleTtl) return []
  return cached.models
}

export function boundedCatalog(
  value: readonly ProviderCatalogModel[],
  maxModels: number,
  maxBytes: number,
): readonly ProviderCatalogModel[] {
  if (!Array.isArray(value)) throw new TypeError('model catalog must be an array')
  if (value.length > maxModels) {
    throw new RangeError(`model catalog exceeds maxCatalogModels (${maxModels})`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new TypeError('model catalog must be JSON-serializable', { cause: error })
  }
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new RangeError(`model catalog exceeds maxCatalogBytes (${maxBytes})`)
  }
  return detachedFrozen(value)
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('HTTP provider operation aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('HTTP provider operation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}
