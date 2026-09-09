import type { ModelCatalogSnapshot } from '../../contract/model-info.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { deepFreeze } from '../../primitives/freeze.ts'
import type { ModelRegistry } from '../../runtime/registry.ts'
import type { RuntimeResources } from '../../platform/resources.ts'
import { NOT_APPLICABLE_USAGE_COVERAGE } from '../../support-safe/error.ts'
import type { RuntimeOperations } from '../lifecycle/operations.ts'
import type { RuntimeProviderInfo } from '../provider/types.ts'
import { MODEL_CATALOG_ERROR_CODES } from './config.ts'
import { captureCatalogOptions, captureCatalogRoute, resolveCatalogPolicy } from './options.ts'
import type {
  CatalogGeneration, ModelCatalogPolicy, PublishedCatalog, RuntimeModelCatalogSnapshot,
} from './types.ts'

interface CacheEntry {
  readonly key: string
  revision: number
  failures: number
  retryAtMs: number
  lastGood?: PublishedCatalog
  latest?: RuntimeModelCatalogSnapshot
  flight: CatalogFlight | undefined
}

interface CatalogFlight {
  readonly controller: AbortController
  readonly task: Promise<RuntimeModelCatalogSnapshot>
  waiters: number
  settled: boolean
}

/** Runtime-owned dynamic catalog cache with per-waiter cancellation. */
export class RuntimeModelCatalog {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly policy: Required<ModelCatalogPolicy>

  constructor(
    private readonly registry: ModelRegistry,
    private readonly operations: RuntimeOperations,
    private readonly resources: RuntimeResources,
    private readonly topology: readonly RuntimeProviderInfo[],
    policy?: ModelCatalogPolicy,
  ) { this.policy = resolveCatalogPolicy(policy) }

  get(routeValue: unknown, optionsValue?: unknown): Promise<RuntimeModelCatalogSnapshot> {
    const route = captureCatalogRoute(routeValue)
    const options = captureCatalogOptions(optionsValue)
    const provider = this.topology.find(row => row.route === route)
    if (provider === undefined) return Promise.reject(new AgentSdkError(
      'Model catalog route is unavailable', MODEL_CATALOG_ERROR_CODES.routeUnavailable,
    ))
    if (options.signal?.aborted) return Promise.reject(cancelled())
    const key = `${provider.pluginId}\u0000${provider.route}`
    const entry = this.entries.get(key) ?? this.createEntry(key)
    const active = entry.flight
    if (active !== undefined) return this.join(active, options.signal)
    const now = this.resources.platform.wallNow()
    if (entry.lastGood?.snapshot.state === 'static') return Promise.resolve(entry.lastGood.snapshot)
    if (options.refresh !== 'force') {
      const cached = this.cached(entry, now)
      if (cached !== undefined) return Promise.resolve(cached)
    }
    const flight = this.start(entry, provider)
    return this.join(flight, options.signal)
  }

  private createEntry(key: string): CacheEntry {
    const entry: CacheEntry = { key, revision: 0, failures: 0, retryAtMs: 0, flight: undefined }
    this.entries.set(key, entry)
    return entry
  }

  private cached(entry: CacheEntry, now: number): RuntimeModelCatalogSnapshot | undefined {
    const good = entry.lastGood
    if (good?.snapshot.state === 'static') return good.snapshot
    if (good?.expiresMs !== undefined && now < good.expiresMs) return good.snapshot
    if (entry.retryAtMs > now) return entry.latest
    return undefined
  }

  private start(entry: CacheEntry, provider: RuntimeProviderInfo): CatalogFlight {
    const controller = this.resources.platform.controller()
    const flight = { controller, waiters: 0, settled: false } as CatalogFlight
    const task = this.operations.execute('model-catalog', { signal: controller.signal }, async lease => {
      try {
        const source = await this.registry.modelCatalog(provider.route, { signal: lease.signal, refresh: 'force' })
        if (lease.signal.aborted) throw cancelled()
        const generation = successfulGeneration(source)
        const now = this.resources.platform.wallNow()
        let published!: RuntimeModelCatalogSnapshot
        if (!lease.publish(() => { published = this.publishSuccess(entry, provider, generation, now) })) throw cancelled()
        return published
      } catch (error) {
        if (lease.signal.aborted) throw cancelled()
        const now = this.resources.platform.wallNow()
        let published!: RuntimeModelCatalogSnapshot
        if (!lease.publish(() => { published = this.publishFailure(entry, provider, now) })) throw cancelled()
        void error
        return published
      }
    })
    Object.defineProperty(flight, 'task', { value: task, enumerable: true })
    entry.flight = flight
    void task.finally(() => {
      flight.settled = true
      if (entry.flight === flight) entry.flight = undefined
    }).catch(() => undefined)
    void task.catch(() => undefined)
    return flight
  }

  private join(flight: CatalogFlight, signal?: AbortSignal): Promise<RuntimeModelCatalogSnapshot> {
    flight.waiters++
    return new Promise((resolve, reject) => {
      let done = false
      let release = (): void => undefined
      const finish = (action: () => void): void => {
        if (done) return
        done = true
        release()
        flight.waiters--
        if (flight.waiters === 0 && !flight.settled) flight.controller.abort()
        action()
      }
      if (signal !== undefined) release = this.resources.onAbort(signal, () => finish(() => reject(cancelled())))
      flight.task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
  }

  private publishSuccess(
    entry: CacheEntry, provider: RuntimeProviderInfo, source: CatalogGeneration, now: number,
  ): RuntimeModelCatalogSnapshot {
    entry.failures = 0
    entry.retryAtMs = 0
    const staticCatalog = source.state === 'static'
    const expiresMs = staticCatalog ? undefined : now + this.policy.freshTtlMs
    const snapshot = deepFreeze({ provider, state: source.state, revision: revision(entry),
      models: source.models, observedAt: iso(now),
      ...(expiresMs === undefined ? {} : { expiresAt: iso(expiresMs) }) })
    entry.lastGood = { snapshot, observedMs: now, ...(expiresMs === undefined ? {} : { expiresMs }) }
    entry.latest = snapshot
    return snapshot
  }

  private publishFailure(
    entry: CacheEntry, provider: RuntimeProviderInfo, now: number,
  ): RuntimeModelCatalogSnapshot {
    entry.failures++
    const delay = Math.min(this.policy.maxFailureRetryMs,
      this.policy.failureRetryMs * 2 ** Math.max(0, entry.failures - 1))
    entry.retryAtMs = now + delay
    const good = entry.lastGood
    const usable = good !== undefined && (good.expiresMs === undefined
      || now <= good.expiresMs + this.policy.staleTtlMs)
    const error = deepFreeze({ code: MODEL_CATALOG_ERROR_CODES.refreshUnavailable,
      stage: 'model-catalog', message: 'Model catalog refresh did not complete',
      usageCoverage: NOT_APPLICABLE_USAGE_COVERAGE, possiblyBilledAttemptsWithoutUsage: 0 })
    const snapshot: RuntimeModelCatalogSnapshot = deepFreeze({
      provider, state: usable ? 'stale' as const : 'unavailable' as const, revision: revision(entry),
      models: usable ? good.snapshot.models : [], observedAt: iso(now), retryAt: iso(entry.retryAtMs), error })
    entry.latest = snapshot
    return snapshot
  }
}

function successfulGeneration(source: ModelCatalogSnapshot): CatalogGeneration {
  if (source.state !== 'static' && source.state !== 'fresh' && source.state !== 'empty') {
    throw new AgentSdkError('Adapter catalog is unavailable', MODEL_CATALOG_ERROR_CODES.refreshUnavailable)
  }
  return Object.freeze({ state: source.state, models: deepFreeze(structuredClone(source.models)) })
}

function revision(entry: CacheEntry): string { return `catalog-${++entry.revision}` }
function iso(value: number): string { return new Date(value).toISOString() }
function cancelled(): AgentSdkError {
  return new AgentSdkError('Model catalog request was cancelled', 'RUNTIME_OPERATION_ABORTED')
}
