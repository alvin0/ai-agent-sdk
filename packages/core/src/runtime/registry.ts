/**
 * The adapter registry and the streaming call API.
 *
 * This is the deepseek-harness `LlmRuntime` with its dependency-injection
 * framework removed: a plain `Map` for routes, an ordered array for the
 * interception point that was a cordis waterfall, and a listener set for the
 * topology event. What is kept is everything that made it trustworthy  E * all-or-nothing validating registration, an atomic route swap, prepare/dispatch
 * generation binding, and a single failure funnel at the adapter boundary.
 *
 * @module ai-agent-sdk/core/runtime/registry
 */

import type { ModelAdapter } from '../contract/adapter.ts'
import {
  callConfigEquals,
  type CallConfig,
  type CallConfigAdapterDefaults,
} from '../contract/call-config.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type {
  ModelContext,
  ModelCatalogOptions,
  ModelCatalogSnapshot,
  ModelInfo,
  ModelModality,
  ProviderInfo,
  ResolvedModelInfo,
} from '../contract/model-info.ts'
import { resolveRetryPolicy, type ResolvedRetryPolicy } from '../contract/retry-policy.ts'
import { ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import { SDK_VERSION } from '../primitives/version.ts'
import type { ObservationResource } from '../observation/event.ts'
import type { ObservationPort } from '../observation/port.ts'
import type { ModelCallHandle, ModelInvocationContext } from '../observation/report.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import { createModelCallHandle } from './model-call-handle.ts'
import { normalizeResolvedModelInfo, resolveCallWithModelInfo,
  validateCatalogModels, validateModelCatalogSnapshot } from './model-metadata.ts'
import { streamAdapter, type PreparedDispatch,
  type RuntimeAdapterRegistration } from './model-stream.ts'
import {
  PLUGIN_ERROR_CODES,
  PluginError,
  type AdapterRegistrationHandle,
  type ModelProviderPlugin,
  type ModelProviderRegistrar,
  type PluginRegistrationHandle,
  type StreamMiddleware,
} from '../plugin/provider-plugin.ts'

export type { AdapterRegistrationHandle, StreamMiddleware } from '../plugin/provider-plugin.ts'

/**
 * Wraps every streaming model call. Call `next()` to reach the adapter, or yield
 * your own chunks to short-circuit it entirely.
 *
 * This is the extension point for retry, caching, request logging, replay, and
 * test doubles. Middleware registered EARLIER sits further out.
 */
/** One call whose configuration and adapter registration were resolved together. */
export interface PreparedCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: CallConfig
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Context capacity resolved with the registration-bound call. */
  readonly context?: ModelContext
  /** Exact model modalities captured with the dispatch generation. */
  readonly inputModalities?: readonly ModelModality[]
  /** Complete validated capability snapshot bound to this adapter generation. */
  readonly model: ResolvedModelInfo
  /** Which config fields the adapter supplied rather than the caller. */
  readonly adapterDefaults: CallConfigAdapterDefaults
  /**
   * Dispatch this call ONCE, through the registration captured at preparation.
   * @param options - the assembled request, carrying the prepared config.
   * @returns the chunk stream, including middleware.
   */
  stream(options: GenerateOptions, context?: ModelInvocationContext): ModelCallHandle
}

export interface ModelRegistryOptions {
  /** Maximum model rows accepted from one adapter catalog. Defaults to 2,048. */
  readonly maxCatalogModels?: number
  /** Maximum serialized bytes accepted from a catalog or model-info record. Defaults to 4 MiB. */
  readonly maxCatalogBytes?: number
  /** Default observation port; a per-call invocation context may override it. */
  readonly observation?: ObservationPort
  /** Safe SDK/service/runtime identity copied onto observation events. */
  readonly observationResource?: ObservationResource
}

type AdapterRegistration = RuntimeAdapterRegistration

interface InstalledPlugin {
  readonly routes: ReadonlySet<string>
  readonly registrations: readonly AdapterRegistration[]
  readonly middleware: readonly StreamMiddleware[]
  readonly cleanup?: () => void
}


function containThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
  let then: unknown
  try {
    then = Reflect.get(value, 'then')
  } catch {
    return true
  }
  if (typeof then !== 'function') return false
  try { void Promise.resolve(value).catch(() => {}) } catch { /* hostile thenable contained */ }
  return true
}

function synchronousCleanupFailure(cleanup: () => void): unknown | undefined {
  try {
    const result: unknown = cleanup()
    return containThenable(result) ? new TypeError('plugin cleanup must be synchronous') : undefined
  } catch (error) {
    return error
  }
}


/**
 * Routes model calls to registered adapters.
 *
 * Construct one per application or isolated runtime scope, register the adapters
 * you use, then call {@link stream} or {@link prepareCall}.
 */
export class ModelRegistry {
  private adapters = new Map<string, AdapterRegistration>()
  private middleware: StreamMiddleware[] = []
  private listeners = new Set<() => void>()
  private plugins = new Map<string, InstalledPlugin>()
  private readonly maxCatalogModels: number
  private readonly maxCatalogBytes: number
  private readonly observation: ObservationPort | undefined
  private readonly observationResource: ObservationResource

  constructor(options: ModelRegistryOptions = {}) {
    this.maxCatalogModels = positiveSafeInteger(options.maxCatalogModels ?? 2_048, 'maxCatalogModels')
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes')
    this.observation = options.observation
    this.observationResource = deepFreeze(options.observationResource ?? {
      sdkName: 'ai-agent-sdk',
      sdkVersion: SDK_VERSION,
      runtime: 'unknown',
    })
  }

  /** Install one provider plugin as a single synchronous topology transaction. */
  install(plugin: ModelProviderPlugin): PluginRegistrationHandle {
    const pluginId = typeof plugin?.id === 'string' ? plugin.id : ''
    const fail = (message: string, cause?: unknown, cleanupFailures: readonly unknown[] = []): never => {
      const causes = [...cause === undefined ? [] : [cause], ...cleanupFailures]
      const wrappedCause = causes.length <= 1 ? causes[0] : new AggregateError(causes, `plugin ${pluginId} install cleanup failed`)
      throw new PluginError(message, PLUGIN_ERROR_CODES.INSTALL_FAILED, pluginId, wrappedCause === undefined ? undefined : { cause: wrappedCause })
    }
    if (pluginId.trim().length === 0 || pluginId !== pluginId.trim()) fail('plugin id must be a non-empty trimmed string')
    if (this.plugins.has(pluginId)) fail(`plugin "${pluginId}" is already installed`)
    if (typeof plugin.displayName !== 'string' || plugin.displayName.trim().length === 0) fail(`plugin "${pluginId}" displayName must be non-empty`)
    if (typeof plugin.setup !== 'function') fail(`plugin "${pluginId}" setup must be a function`)
    const family = plugin.family ?? pluginId
    if (typeof family !== 'string' || family.trim().length === 0 || family !== family.trim()) {
      fail(`plugin "${pluginId}" family must be a non-empty trimmed string`)
    }
    const owner = Object.freeze({ pluginId, family })

    interface StagedAdapter {
      active: boolean
      routes: string[]
      readonly adapter: ModelAdapter
    }
    interface StagedMiddleware { active: boolean; readonly middleware: StreamMiddleware }
    const stagedAdapters: StagedAdapter[] = []
    const stagedMiddleware: StagedMiddleware[] = []
    let staging = true

    const registrar: ModelProviderRegistrar = {
      registerAdapter: (routes, adapter) => {
        if (!staging) fail(`plugin "${pluginId}" staging registrar is closed`)
        if (routes.length === 0) throw new ModelError('an adapter must register at least one provider route', REGISTRY_ERROR_CODES.INVALID_ADAPTER)
        const item: StagedAdapter = { active: true, routes: [...routes], adapter }
        // Validate metadata and conflicts without mutating live routes.
        const occupied = new Set(stagedAdapters.filter(value => value.active).flatMap(value => value.routes))
        for (const route of routes) if (occupied.has(route)) {
          throw new ModelError(`an adapter for provider route "${route}" is already staged`, REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
        }
        this.prepareRoutes(routes, adapter, new Set(), owner)
        stagedAdapters.push(item)
        const handle = (() => {
          if (staging) item.active = false
        }) as AdapterRegistrationHandle
        handle.replace = (next) => {
          if (!staging || !item.active) throw new ModelError('a disposed staged registration cannot replace routes', REGISTRY_ERROR_CODES.REGISTRATION_DISPOSED)
          const occupiedByOthers = new Set(stagedAdapters.filter(value => value.active && value !== item).flatMap(value => value.routes))
          for (const route of next) if (occupiedByOthers.has(route)) {
            throw new ModelError(`an adapter for provider route "${route}" is already staged`, REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
          }
          this.prepareRoutes(next, adapter, new Set(), owner)
          item.routes = [...next]
        }
        return handle
      },
      use: (middleware) => {
        if (!staging) fail(`plugin "${pluginId}" staging registrar is closed`)
        if (typeof middleware !== 'function') throw new TypeError('plugin middleware must be a function')
        const item: StagedMiddleware = { active: true, middleware }
        stagedMiddleware.push(item)
        return () => { if (staging) item.active = false }
      },
    }

    let cleanup: (() => void) | undefined
    try {
      const result = plugin.setup(registrar)
      if (containThenable(result)) fail(`plugin "${pluginId}" setup must be synchronous`)
      if (result !== undefined && typeof result !== 'function') fail(`plugin "${pluginId}" setup must be synchronous and return void or cleanup`)
      cleanup = typeof result === 'function' ? result : undefined
    } catch (error) {
      if (error instanceof PluginError && error.code === PLUGIN_ERROR_CODES.INSTALL_FAILED) throw error
      fail(`plugin "${pluginId}" setup failed`, error)
    } finally {
      staging = false
    }

    const registrations: AdapterRegistration[] = []
    const routeNames = new Set<string>()
    try {
      for (const item of stagedAdapters) {
        if (!item.active) continue
        for (const route of item.routes) {
          if (routeNames.has(route)) throw new ModelError(`an adapter for provider route "${route}" is already staged`, REGISTRY_ERROR_CODES.DUPLICATE_ADAPTER)
          routeNames.add(route)
        }
        registrations.push(...this.prepareRoutes(item.routes, item.adapter, new Set(), owner))
      }
    } catch (error) {
      const cleanupFailures: unknown[] = []
      if (cleanup) {
        const cleanupFailure = synchronousCleanupFailure(cleanup)
        if (cleanupFailure !== undefined) cleanupFailures.push(cleanupFailure)
      }
      fail(`plugin "${pluginId}" commit validation failed`, error, cleanupFailures)
    }

    const committedMiddleware = stagedMiddleware.filter(item => item.active).map(item => item.middleware)
    for (const registration of registrations) this.adapters.set(registration.provider.id, registration)
    this.middleware.push(...committedMiddleware)
    const installed: InstalledPlugin = {
      routes: routeNames,
      registrations,
      middleware: committedMiddleware,
      ...(cleanup === undefined ? {} : { cleanup }),
    }
    this.plugins.set(pluginId, installed)
    this.emitAdaptersUpdated()

    let disposed = false
    const dispose = (() => {
      if (disposed) return
      disposed = true
      this.plugins.delete(pluginId)
      for (const registration of installed.registrations) {
        if (this.adapters.get(registration.provider.id) === registration) this.adapters.delete(registration.provider.id)
      }
      for (let index = installed.middleware.length - 1; index >= 0; index--) {
        const middleware = installed.middleware[index]
        const liveIndex = middleware === undefined ? -1 : this.middleware.lastIndexOf(middleware)
        if (liveIndex >= 0) this.middleware.splice(liveIndex, 1)
      }
      this.emitAdaptersUpdated()
      const failures: unknown[] = []
      if (installed.cleanup) {
        const cleanupFailure = synchronousCleanupFailure(installed.cleanup)
        if (cleanupFailure !== undefined) failures.push(cleanupFailure)
      }
      if (failures.length > 0) {
        throw new PluginError(
          `plugin "${pluginId}" cleanup failed`,
          PLUGIN_ERROR_CODES.CLEANUP_FAILED,
          pluginId,
          { cause: new AggregateError(failures, `plugin "${pluginId}" cleanup failed`) },
        )
      }
    }) as PluginRegistrationHandle
    Object.defineProperty(dispose, 'pluginId', { value: pluginId, enumerable: true })
    return dispose
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
   * holds as available. Mutates nothing  Ea rejected candidate leaves the registry
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
      if (typeof info.id !== 'string' || info.id !== provider
        || typeof info.name !== 'string' || info.name.length === 0) {
        throw new ModelError(
          `adapter metadata for route "${provider}" must preserve its id and carry a non-empty name`,
          REGISTRY_ERROR_CODES.INVALID_ADAPTER,
        )
      }
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
   * Install streaming middleware.
   * @param middleware - wrapper invoked around every call; earlier registrations sit further out.
   * @returns a disposer that removes exactly this middleware.
   */
  use(middleware: StreamMiddleware): () => void {
    this.middleware.push(middleware)
    return () => {
      const index = this.middleware.indexOf(middleware)
      if (index >= 0) this.middleware.splice(index, 1)
    }
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

  /**
   * List the models one route advertises.
   *
   * Re-validated here rather than trusted, because a malformed catalog entry
   * surfaces in a caller's model picker where its origin is far from obvious.
   * @param provider - a registered route.
   * @returns detached, validated model metadata.
   */
  async listModels(provider: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const registration = this.registration(provider)
    const models = await registration.adapter.listModels(provider, signal)
    return validateCatalogModels(provider, models, this.maxCatalogModels, this.maxCatalogBytes)
  }

  /** Resolve and validate one uncached adapter-level catalog generation. */
  async modelCatalog(provider: string, options: ModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    const registration = this.registration(provider)
    const snapshot = await registration.adapter.modelCatalog(provider, options)
    return validateModelCatalogSnapshot(provider, snapshot, this.maxCatalogModels, this.maxCatalogBytes)
  }

  /**
   * Resolve metadata for one exact model.
   * @param provider - a registered route.
   * @param model - exact model id.
   * @param signal - cancellation for adapter-side resolution.
   * @returns validated, detached metadata.
   */
  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    const registration = this.registration(provider)
    const resolved = await registration.adapter.resolveModel(provider, model, signal)
    return normalizeResolvedModelInfo(registration.provider.id, model, resolved, this.maxCatalogBytes)
  }

  /** The retry policy captured for one route. */
  retryPolicy(provider: string): ResolvedRetryPolicy {
    return this.registration(provider).retryPolicy
  }

  /**
   * Resolve one call under its CURRENT adapter registration, returning a one-shot
   * handle that keeps that registration through to dispatch.
   * @param config - route, model, and optional request controls.
   * @param signal - cancellation for adapter-side capability lookup.
   * @returns the prepared config and its registration-bound stream entry point.
   */
  async prepareCall(
    config: CallConfig,
    signal?: AbortSignal,
    invocationContext?: ModelInvocationContext,
  ): Promise<PreparedCall> {
    const registration = this.registration(config.provider)
    const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal, invocationContext)
    const modelInfo = normalizeResolvedModelInfo(
      registration.provider.id, config.model, adapterCall.model, this.maxCatalogBytes,
    )
    const resolved = resolveCallWithModelInfo(config, modelInfo)
    const resolvedConfig = deepFreeze(structuredClone(resolved.config))
    const context = resolved.context === undefined
      ? undefined
      : deepFreeze(structuredClone(resolved.context))
    const adapterDefaults = deepFreeze<CallConfigAdapterDefaults>({
      ...config.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
        ? { reasoningEffort: true as const }
        : {},
      ...config.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
        ? { maxTokens: true as const }
        : {},
    })

    let dispatched = false
    const model = deepFreeze(structuredClone(modelInfo))
    return Object.freeze({
      config: resolvedConfig,
      model,
      retryPolicy: registration.retryPolicy,
      adapterDefaults,
      ...context === undefined ? {} : { context },
      ...modelInfo.inputModalities === undefined
        ? {}
        : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
      stream: (options: GenerateOptions, context = invocationContext): ModelCallHandle => {
        // Both guards below exist so a stale handle fails loudly instead of
        // quietly dispatching against a configuration nobody vetted.
        if (dispatched) {
          throw new ModelError(
            'a prepared call can only be dispatched once',
            REGISTRY_ERROR_CODES.INVALID_PREPARED_CALL,
          )
        }
        if (!callConfigEquals(options, resolvedConfig)) {
          throw new ModelError(
            'prepared call config changed before adapter dispatch',
            REGISTRY_ERROR_CODES.INVALID_PREPARED_CALL,
          )
        }
        dispatched = true
        return this.dispatch(options, context, {
          registration,
          config: resolvedConfig,
          modelInfo,
          dispatch: (request, activeContext) => adapterCall.stream(request, activeContext),
        })
      },
    })
  }

  /**
   * Stream one model call as raw chunks.
   *
   * Adapter selection, dispatch, and iteration failures become terminal `error` or
   * `aborted` finish chunks. Middleware and consumer failures stay THROWN  Ethose
   * are bugs in code the caller controls, and converting them to a finish reason
   * would hide them.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, wrapped by any installed middleware.
   */
  stream(options: GenerateOptions, context?: ModelInvocationContext): ModelCallHandle {
    return this.dispatch(options, context)
  }

  private dispatch(
    options: GenerateOptions,
    context?: ModelInvocationContext,
    prepared?: PreparedDispatch,
  ): ModelCallHandle {
    let dispatchState: 'not-sent' | 'unknown' = 'not-sent'
    const registration = prepared?.registration ?? this.adapters.get(options.provider)
    return createModelCallHandle({
      options,
      ...(registration?.family === undefined ? {} : { providerFamily: registration.family }),
      ...(registration?.pluginId === undefined ? {} : { providerPluginId: registration.pluginId }),
      ...(registration === undefined ? {} : { isRetryable: (code: string) => (
        registration.retryPolicy.mode === 'always'
          || registration.retryPolicy.retryableCodes.includes(code)
      ) }),
      ...(context === undefined ? {} : { context }),
      ...(this.observation === undefined ? {} : { defaultObservation: this.observation }),
      resource: this.observationResource,
      routePresent: prepared !== undefined || this.adapters.has(options.provider),
      dispatchState: () => dispatchState,
      stream: activeContext => this.dispatchRaw(
        options,
        activeContext,
        () => { dispatchState = 'unknown' },
        prepared,
      ),
    })
  }

  /**
   * Compose installed middleware around the adapter boundary.
   *
   * Composition is deferred to the first iteration rather than done eagerly, so
   * that `stream()` ALWAYS returns an iterable and every failure — including a
   * middleware that throws synchronously — surfaces on the same path. Composing
   * eagerly would give callers two different error channels for the same class of
   * fault, and they would inevitably handle only one.
   *
   * The middleware list is snapshotted here so that installing or removing
   * middleware mid-stream cannot change the chain of a call already in flight.
   */
  private dispatchRaw(
    options: GenerateOptions,
    context: ModelInvocationContext,
    onDispatch: () => void,
    prepared?: PreparedDispatch,
  ): AsyncIterable<StreamChunk> {
    const chain = [...this.middleware]
    const run = (): AsyncIterable<StreamChunk> => {
      let next = (): AsyncIterable<StreamChunk> => streamAdapter({
        options, context, onDispatch, maxCatalogBytes: this.maxCatalogBytes,
        registration: provider => this.registration(provider),
        registeredAdapter: provider => this.adapters.get(provider)?.adapter,
        ...(prepared === undefined ? {} : { prepared }),
      })
      for (let index = chain.length - 1; index >= 0; index--) {
        const middleware = chain[index]
        if (middleware === undefined) continue
        const inner = next
        next = () => middleware(options, inner, context)
      }
      return next()
    }
    return {
      async * [Symbol.asyncIterator]() {
        yield* run()
      },
    }
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (registration === undefined) {
      throw new ModelError(
        `no adapter registered for provider route "${provider}"`,
        REGISTRY_ERROR_CODES.NO_ADAPTER,
      )
    }
    return registration
  }

}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`ModelRegistry ${label} must be a positive safe integer`)
  }
  return value
}
