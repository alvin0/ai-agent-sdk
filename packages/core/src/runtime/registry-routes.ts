/** Own adapter topology, atomic registration swaps, and topology notifications. */
import type {
  ModelAdapter,
} from '../contract/adapter.ts'

import type {
  ProviderInfo,
} from '../contract/model-info.ts'
import {
  resolveRetryPolicy,
} from '../contract/retry-policy.ts'
import {
  ModelError, REGISTRY_ERROR_CODES,
} from '../errors/model-error.ts'

import type {
  RuntimeAdapterRegistration,
} from './model-stream.ts'
import {
  type AdapterRegistrationHandle, type ModelProviderPlugin, type PluginRegistrationHandle, type StreamMiddleware,
} from '../plugin/provider-plugin.ts'
import {
  validateAdapterInfo,
} from './registry-support.ts'
import {
  installProviderPlugin, type InstalledPlugin,
} from './registry-plugin.ts'

type AdapterRegistration = RuntimeAdapterRegistration

export class RegistryRoutes {
  private readonly adapters = new Map<string, AdapterRegistration>()
  private readonly plugins = new Map<string, InstalledPlugin>()
  private readonly listeners = new Set<() => void>()

  /** Install one provider plugin as a single synchronous topology transaction. */
  install(plugin: ModelProviderPlugin, middleware: StreamMiddleware[]): PluginRegistrationHandle {
    return installProviderPlugin(plugin, {
      adapters: this.adapters, middleware, plugins: this.plugins,
      prepareRoutes: (routes, adapter, owned, owner) => this.prepareRoutes(routes, adapter, owned, owner),
      emitAdaptersUpdated: () => this.emitAdaptersUpdated(),
    })
  }

  /**
   * Register an adapter for the given routes.
   *
   * All-or-nothing: if ANY route conflicts, nothing is registered. A partial
   * registration would leave the caller believing a route exists when it does not.
   * @param providers - every route this adapter should serve; must be non-empty.
   * @param adapter - the adapter that streams calls for those routes.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(
    providers: readonly string[],
    adapter: ModelAdapter,
  ): AdapterRegistrationHandle {
    if (providers.length === 0) {
      throw new ModelError(
        'an adapter must register at least one provider route',
        REGISTRY_ERROR_CODES.INVALID_ADAPTER,
      )
    }
    /** Routes this registration currently holds; `replace` rewrites it. */
    const owned = new Set<string>()
    // `owned` being empty cannot signal disposal on its own, because
    // `replace([])` legally leaves a live registration holding no routes.
    let released = false

    this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))

    const handle = (() => {
      if (released) return
      released = true
      for (const provider of owned) this.adapters.delete(provider)
      owned.clear()
      this.emitAdaptersUpdated()
    }) as AdapterRegistrationHandle

    handle.replace = (next: readonly string[]): void => {
      // Registering after disposal would leak: nothing remains to release what
      // this call would put back into the map.
      if (released) {
        throw new ModelError(
          'a disposed adapter registration cannot replace its routes',
          REGISTRY_ERROR_CODES.REGISTRATION_DISPOSED,
        )
      }
      this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned))
    }
    return handle
  }

  /**
   * Validate one candidate route set, treating routes this registration already
   * holds as available. Mutates nothing: a rejected candidate leaves the registry
   * exactly as it was.
   */
  private prepareRoutes(
    providers: readonly string[],
    adapter: ModelAdapter,
    owned: ReadonlySet<string>,
    owner?: Readonly<{ pluginId: string; family: string }>,
  ): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (typeof provider !== 'string' || provider.length === 0) {
        throw new ModelError(
          'adapter provider route names must be non-empty strings',
          REGISTRY_ERROR_CODES.INVALID_ADAPTER,
        )
      }
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new ModelError(
          `an adapter for provider route "${provider}" is already registered`,
          REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER,
        )
      }
      const info = adapter.providerInfo(provider)
      validateAdapterInfo(provider, info)
      unique.add(provider)
      registrations.push({
        adapter,
        provider: { id: info.id, name: info.name },
        ...(owner === undefined ? {} : owner),
        // Captured at REGISTRATION time, not per call. An adapter whose policy
        // follows mutable configuration re-registers via `handle.replace`.
        retryPolicy: adapter.providerRetryPolicy(provider)
          ?? resolveRetryPolicy(undefined, `provider "${provider}" retryPolicy`),
      })
    }
    return registrations
  }

  /**
   * Swap this registration's routes in ONE synchronous section, so no caller can
   * observe the registry between the release and the re-registration.
   */
  private commitRoutes(
    owned: Set<string>,
    registrations: readonly AdapterRegistration[],
  ): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
    this.emitAdaptersUpdated()
  }

  /**
   * Observe route-topology changes (registration, replacement, disposal).
   * @param listener - payload-free notification; re-read `listProviders()` for new state.
   * @returns a disposer that removes the listener.
   */
  onAdaptersUpdated(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
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

  /**
   * Describe every route with a registered adapter.
   * @returns detached provider metadata, in registration order.
   */
  listProviders(): ProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new ModelError(
        `no adapter registered for provider route "${provider}"`,
        REGISTRY_ERROR_CODES.NO_ADAPTER,
      )
    }
    return registration
  }

  has(provider: string): boolean { return this.adapters.has(provider) }

  find(provider: string): AdapterRegistration | undefined { return this.adapters.get(provider) }
}
