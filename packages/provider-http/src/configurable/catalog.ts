import type { ProviderCatalogModel } from '../base/http-types.ts'
import type { HttpProviderOptions } from './http-options.ts'
import { observeModelCatalogOperation } from '../observation/operations.ts'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import {
  boundedCatalog,
  staleCatalog,
  raceAbort,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_CATALOG_STALE_TTL_MS,
  DEFAULT_CATALOG_FAILURE_BACKOFF_MS,
  DEFAULT_MAX_CATALOG_MODELS,
  DEFAULT_MAX_CATALOG_BYTES,
} from './configuration-support.ts'

export class HttpCatalog<Dialect extends object> {
  private catalog: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined
  private catalogFailureAt: number | undefined

  constructor(private readonly options: HttpProviderOptions<Dialect>) {}

  get failed(): boolean { return this.catalogFailureAt !== undefined }

  /** Run the discovery hook, memoized, tolerating failure. */
  async resolve(
    provider: string,
    baseUrl: string,
    headers: Record<string, string>,
    operation: { signal: AbortSignal | undefined; context: ModelInvocationContext | undefined },
  ): Promise<readonly ProviderCatalogModel[]> {
    const { signal, context } = operation
    const discover = this.options.discoverModels
    if (discover === undefined) return []
    const { ttl, staleTtl, failureBackoff } = this.policy()
    const now = Date.now()
    const cached = this.catalog
    if (cached !== undefined && now - cached.fetchedAt < ttl) return cached.models
    if (this.catalogFailureAt !== undefined && now - this.catalogFailureAt < failureBackoff) {
      return staleCatalog(cached, now, ttl, staleTtl)
    }

    try {
      const discovered = await observeModelCatalogOperation(
        context,
        provider,
        new URL(baseUrl).origin,
        async () => {
          const pending = discover({
            baseUrl,
            headers,
            provider,
            ...(context === undefined ? {} : { context }),
            ...signal === undefined ? {} : { signal },
          })
          return signal === undefined ? await pending : await raceAbort(pending, signal)
        },
      )
      const models = boundedCatalog(
        discovered,
        this.options.maxCatalogModels ?? DEFAULT_MAX_CATALOG_MODELS,
        this.options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
      )
      this.catalog = { models, fetchedAt: Date.now() }
      this.catalogFailureAt = undefined
      return models
    } catch (error: unknown) {
      return this.failedDiscovery(error, { signal, cached, ttl, staleTtl })
    }
  }

  private policy() {
    const ttl = this.options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
    const staleTtl = this.options.catalogStaleTtlMs ?? DEFAULT_CATALOG_STALE_TTL_MS
    const failureBackoff = this.options.catalogFailureBackoffMs
      ?? DEFAULT_CATALOG_FAILURE_BACKOFF_MS
    return { ttl, staleTtl, failureBackoff }
  }

  private failedDiscovery(error: unknown, state: {
    signal: AbortSignal | undefined; cached: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined;
    ttl: number; staleTtl: number
  }): readonly ProviderCatalogModel[] {
    const { signal, cached, ttl, staleTtl } = state
      // Cancellation belongs to the caller/runtime refresh generation. Treating
      // it as an offline empty catalog would publish a false successful result.
      if (signal?.aborted === true) throw signal.reason ?? error
      // Offline, unauthorized for metadata, or transient. An empty catalog only
      // costs capability detail; failing the call would cost the whole request.
      this.catalogFailureAt = Date.now()
      return staleCatalog(cached, this.catalogFailureAt, ttl, staleTtl)
  }
}
