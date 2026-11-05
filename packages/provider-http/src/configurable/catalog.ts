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

interface CatalogRequest {
  readonly provider: string
  readonly baseUrl: string
  readonly headers: Record<string, string>
  readonly signal: AbortSignal | undefined
  readonly context: ModelInvocationContext | undefined
}

export class HttpCatalog<Dialect extends object> {
  private catalog: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined
  private catalogFailureAt: number | undefined
  private inflight: Promise<readonly ProviderCatalogModel[]> | undefined

  constructor(private readonly options: HttpProviderOptions<Dialect>) {}

  get failed(): boolean { return this.catalogFailureAt !== undefined }

  /** Run the discovery hook, memoized and single-flight, tolerating failure. */
  async resolve(
    provider: string,
    baseUrl: string,
    headers: Record<string, string>,
    operation: { signal: AbortSignal | undefined; context: ModelInvocationContext | undefined },
  ): Promise<readonly ProviderCatalogModel[]> {
    if (this.options.discoverModels === undefined) return []
    const request: CatalogRequest = { provider, baseUrl, headers, ...operation }
    return await this.resolveRequest(request)
  }

  private async resolveRequest(request: CatalogRequest): Promise<readonly ProviderCatalogModel[]> {
    const { ttl, staleTtl, failureBackoff } = this.policy()
    const now = Date.now()
    const cached = this.catalog
    if (cached !== undefined && now - cached.fetchedAt < ttl) return cached.models
    if (this.catalogFailureAt !== undefined && now - this.catalogFailureAt < failureBackoff) {
      return staleCatalog(cached, now, ttl, staleTtl)
    }
    // Concurrent cold calls (many runs starting at once, or a TTL expiring under
    // load) share one discovery instead of each sending its own catalog request.
    const shared = this.inflight
    if (shared !== undefined) return await this.follow(shared, request)
    const leader = this.discover(request, cached)
    this.inflight = leader
    try {
      return await leader
    } finally {
      if (this.inflight === leader) this.inflight = undefined
    }
  }

  private async follow(
    shared: Promise<readonly ProviderCatalogModel[]>, request: CatalogRequest,
  ): Promise<readonly ProviderCatalogModel[]> {
    const { signal } = request
    try {
      return await (signal === undefined ? shared : raceAbort(shared, signal))
    } catch (error: unknown) {
      if (signal?.aborted === true) throw signal.reason ?? error
    }
    // Only the leader's own cancellation rejects the shared discovery: take over.
    return await this.resolveRequest(request)
  }

  private async discover(
    request: CatalogRequest,
    cached: { models: readonly ProviderCatalogModel[]; fetchedAt: number } | undefined,
  ): Promise<readonly ProviderCatalogModel[]> {
    const { provider, baseUrl, headers, signal, context } = request
    const discover = this.options.discoverModels!
    const { ttl, staleTtl } = this.policy()
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
