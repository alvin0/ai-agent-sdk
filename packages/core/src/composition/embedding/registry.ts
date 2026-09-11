/**
 * The embedding adapter registry: resolution by route + operation + model id.
 *
 * Deliberately a SEPARATE object from `ModelRegistry` rather than a second map
 * inside it. Both are keyed by route, but they answer different operations, and
 * keeping them apart is what makes it structurally impossible for a
 * `ModelAdapter` to be handed an embedding call or an `EmbeddingAdapter` a
 * generation call (Requirement 11.10). A route may legitimately carry a
 * generation plugin AND an embedding plugin at the same time.
 *
 * Within one route, resolution is two-tier: entries that declared `models[]`
 * match first, then a route-wide entry (one that declared no models), and when
 * neither exists the lookup fails fast with `EMBEDDING_ADAPTER_MISSING`
 * (Requirement 3.5). Model-scoped beats route-wide because a plugin that names
 * ids is making a narrower, more specific claim than one that claims the route.
 *
 * Registration mirrors `ModelRegistry` conventions: validate-then-commit so a
 * rejected candidate leaves the registry exactly as it was, all-or-nothing over
 * the whole route set, and a disposer handle that also supports `replace()`.
 *
 * @module ai-agent-sdk/core/composition/embedding/registry
 */

import type { ProviderInfo } from '../../contract/model-info.ts'
import type { ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import type { EmbeddingAdapter } from '../../embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { AdapterRegistrationHandle } from '../../plugin/provider-plugin.ts'
import type { EmbeddingProviderRegistrar } from './plugin-types.ts'

/** One resolved embedding registration, detached from registry internals. */
export interface EmbeddingRegistration {
  /** The route this registration was resolved for. */
  readonly route: string
  /** Adapter-declared route metadata, validated at registration time. */
  readonly provider: ProviderInfo
  /** The adapter that will perform `Provider_Attempt`s for this route. */
  readonly adapter: EmbeddingAdapter
  /** Captured at REGISTRATION time; absent means "accept the runtime defaults". */
  readonly retryPolicy?: ResolvedRetryPolicy
  /** Model ids this registration claims; absent means the whole route. */
  readonly models?: readonly string[]
}

/** One route entry held by exactly one registration. */
interface RouteEntry {
  readonly route: string
  readonly provider: ProviderInfo
  readonly adapter: EmbeddingAdapter
  readonly retryPolicy?: ResolvedRetryPolicy
  /** `undefined` marks a route-wide entry. */
  readonly models?: ReadonlySet<string>
}

/** Mutable per-registration state; `replace()` rewrites `entries` wholesale. */
interface RegistrationState {
  entries: readonly RouteEntry[]
  released: boolean
}

/** Resolution index rebuilt from the live registrations after every commit. */
interface RouteIndex {
  readonly byModel: Map<string, RouteEntry>
  wide?: RouteEntry
}

const conflictError = (message: string) => new AgentSdkError(message, 'EMBEDDING_ROUTE_CONFLICT')
const invalidError = (message: string) => new AgentSdkError(message, 'EMBEDDING_REGISTRATION_INVALID')

/** Only pass identity facts the error contract accepts as non-empty strings. */
function errorIdentity(route: unknown, model: unknown): { provider?: string; model?: string } {
  return {
    ...(typeof route === 'string' && route.length > 0 ? { provider: route } : {}),
    ...(typeof model === 'string' && model.length > 0 ? { model } : {}),
  }
}

/**
 * Routes embedding calls to registered `EmbeddingAdapter`s.
 *
 * Construct one per runtime, beside — never inside — the `ModelRegistry`.
 */
export class EmbeddingRegistry implements EmbeddingProviderRegistrar {
  private readonly registrations = new Set<RegistrationState>()
  private index = new Map<string, RouteIndex>()
  private readonly listeners = new Set<() => void>()

  /**
   * Register one adapter for the given routes, optionally scoped to model ids.
   *
   * All-or-nothing: if ANY route conflicts, nothing is registered, because a
   * partial registration would leave the caller believing a route exists when it
   * does not.
   * @param routes - every route this registration serves; must be non-empty and unique.
   * @param adapter - the adapter that performs the embedding requests.
   * @param models - exact model ids this registration claims; omit to claim the routes.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerEmbeddingAdapter(
    routes: readonly string[],
    adapter: EmbeddingAdapter,
    models?: readonly string[],
  ): AdapterRegistrationHandle {
    const claimed = capturedModels(models)
    const state: RegistrationState = { entries: [], released: false }
    state.entries = this.prepareEntries(routes, adapter, claimed, state)
    this.registrations.add(state)
    this.commit()

    const handle = (() => {
      if (state.released) return
      state.released = true
      this.registrations.delete(state)
      state.entries = []
      this.commit()
    }) as AdapterRegistrationHandle

    handle.replace = (next: readonly string[]): void => {
      // Re-registering after disposal would leak: nothing remains that could
      // release what this call would put back into the index.
      if (state.released) {
        throw new AgentSdkError(
          'a disposed embedding registration cannot replace its routes',
          'EMBEDDING_REGISTRATION_DISPOSED',
        )
      }
      const prepared = this.prepareEntries(next, adapter, claimed, state)
      state.entries = prepared
      this.commit()
    }
    return handle
  }

  /**
   * Resolve the adapter for one route + model id, embedding operation only.
   *
   * @param route - provider route key.
   * @param model - exact model id, as the caller asked for it.
   * @throws EmbeddingError `EMBEDDING_ADAPTER_MISSING` when nothing claims the pair,
   *   including when the route only carries a generation adapter (Requirement 3.5).
   */
  resolve(route: string, model: string): EmbeddingRegistration {
    const routeIndex = typeof route === 'string' ? this.index.get(route) : undefined
    const entry = routeIndex === undefined ? undefined
      : (typeof model === 'string' ? routeIndex.byModel.get(model) : undefined) ?? routeIndex.wide
    if (entry === undefined) {
      throw new EmbeddingError(
        `no embedding adapter is registered for route "${String(route)}" and model "${String(model)}"`,
        EMBEDDING_ERROR_CODES.ADAPTER_MISSING,
        errorIdentity(route, model),
      )
    }
    return Object.freeze({
      route: entry.route,
      provider: { ...entry.provider },
      adapter: entry.adapter,
      ...(entry.retryPolicy === undefined ? {} : { retryPolicy: entry.retryPolicy }),
      ...(entry.models === undefined ? {} : { models: Object.freeze([...entry.models]) }),
    })
  }

  /** Whether any embedding entry — model-scoped or route-wide — claims this route. */
  hasRoute(route: string): boolean {
    return typeof route === 'string' && this.index.has(route)
  }

  /** Every route with at least one embedding entry, in index order. */
  listRoutes(): readonly string[] {
    return Object.freeze([...this.index.keys()])
  }

  /**
   * Observe embedding topology changes (registration, replacement, disposal).
   * @param listener - payload-free notification; re-read {@link listRoutes} for new state.
   * @returns a disposer that removes exactly this listener.
   */
  onAdaptersUpdated(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /**
   * Validate one candidate route set without mutating anything, treating entries
   * the same registration already holds as available.
   */
  private prepareEntries(
    routes: readonly string[],
    adapter: EmbeddingAdapter,
    models: ReadonlySet<string> | undefined,
    owner: RegistrationState,
  ): readonly RouteEntry[] {
    if (!Array.isArray(routes) || routes.length === 0) {
      throw invalidError('an embedding adapter must register at least one provider route')
    }
    if (adapter === null || typeof adapter !== 'object' || typeof adapter.embedBatch !== 'function') {
      throw invalidError('an embedding registration requires an EmbeddingAdapter')
    }
    const unique = new Set<string>()
    const entries: RouteEntry[] = []
    for (const route of routes) {
      if (typeof route !== 'string' || route.length === 0) {
        throw invalidError('embedding adapter provider route names must be non-empty strings')
      }
      if (unique.has(route)) {
        throw conflictError(`embedding route "${route}" is claimed twice by one registration`)
      }
      this.checkVacancy(route, models, owner)
      const info = adapter.providerInfo(route)
      if (info === null || typeof info !== 'object' || info.id !== route
        || typeof info.name !== 'string' || info.name.length === 0) {
        throw invalidError(
          `embedding adapter metadata for route "${route}" must preserve its id and carry a non-empty name`,
        )
      }
      const retryPolicy = adapter.providerRetryPolicy(route)
      unique.add(route)
      entries.push(Object.freeze({
        route,
        provider: Object.freeze({ id: info.id, name: info.name }),
        adapter,
        // Captured at REGISTRATION time, not per call: an adapter whose policy
        // follows mutable configuration re-registers through `handle.replace`.
        ...(retryPolicy === undefined ? {} : { retryPolicy }),
        ...(models === undefined ? {} : { models }),
      }))
    }
    return Object.freeze(entries)
  }

  /**
   * A model-scoped claim and a route-wide claim coexist by design — that IS the
   * two-tier resolution. Two claims of the SAME tier over the same id do not.
   */
  private checkVacancy(
    route: string,
    models: ReadonlySet<string> | undefined,
    owner: RegistrationState,
  ): void {
    for (const state of this.registrations) {
      if (state === owner) continue
      for (const entry of state.entries) {
        if (entry.route !== route) continue
        if (entry.models === undefined && models === undefined) {
          throw conflictError(`an embedding adapter for route "${route}" is already registered`)
        }
        if (entry.models === undefined || models === undefined) continue
        for (const model of models) {
          if (entry.models.has(model)) {
            throw conflictError(
              `an embedding adapter for route "${route}" and model "${model}" is already registered`,
            )
          }
        }
      }
    }
  }

  /**
   * Rebuild the resolution index in ONE synchronous section, so no caller can
   * observe the registry between a release and a re-registration.
   */
  private commit(): void {
    const index = new Map<string, RouteIndex>()
    for (const state of this.registrations) {
      for (const entry of state.entries) {
        let routeIndex = index.get(entry.route)
        if (routeIndex === undefined) {
          routeIndex = { byModel: new Map<string, RouteEntry>() }
          index.set(entry.route, routeIndex)
        }
        if (entry.models === undefined) routeIndex.wide = entry
        else for (const model of entry.models) routeIndex.byModel.set(model, entry)
      }
    }
    this.index = index
    this.emitAdaptersUpdated()
  }

  /**
   * Notify topology observers.
   *
   * Each listener is contained independently: a topology notification is not a
   * veto, so one broken observer must not starve the others or roll back a
   * registration that already happened.
   */
  private emitAdaptersUpdated(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // Contained deliberately; see above.
      }
    }
  }
}

/** Copy and validate the optional model claim so later mutation cannot widen it. */
function capturedModels(models: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (models === undefined) return undefined
  if (!Array.isArray(models) || models.length === 0) {
    throw invalidError('embedding adapter model selection must be non-empty')
  }
  const captured = new Set<string>()
  for (const model of models) {
    if (typeof model !== 'string' || model.length === 0) {
      throw invalidError('embedding adapter model ids must be non-empty strings')
    }
    if (captured.has(model)) {
      throw invalidError('embedding adapter model selection must be unique')
    }
    captured.add(model)
  }
  return captured
}
