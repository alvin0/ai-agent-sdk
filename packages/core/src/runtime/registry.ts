import {
  RegistryRoutes,
} from './registry-routes.ts'
/**
 * The adapter registry and the streaming call API.
 *
 * This is the deepseek-harness `LlmRuntime` with its dependency-injection
 * framework removed: a plain `Map` for routes, an ordered array for the
 * interception point that was a cordis waterfall, and a listener set for the
 * topology event. What is kept is everything that made it trustworthy:
 * all-or-nothing validating registration, atomic route swaps, prepare/dispatch
 * generation binding, and a single failure funnel at the adapter boundary.
 *
 * @module ai-agent-sdk/core/runtime/registry
 */

import type {
  ModelAdapter,
} from '../contract/adapter.ts'
import type {
  CallConfig,
} from '../contract/call-config.ts'
import type {
  GenerateOptions,
} from '../contract/generate-options.ts'
import type {
  ModelCatalogOptions, ModelCatalogSnapshot, ModelInfo, ProviderInfo, ResolvedModelInfo, RuntimeDefaults,
} from '../contract/model-info.ts'
import {
  type ResolvedRetryPolicy,
} from '../contract/retry-policy.ts'

import {
  deepFreeze,
} from '../primitives/freeze.ts'
import {
  SDK_VERSION,
} from '../primitives/version.ts'
import type {
  ObservationResource,
} from '../observation/event.ts'
import type {
  ObservationPort,
} from '../observation/port.ts'
import type {
  ModelCallHandle, ModelInvocationContext,
} from '../observation/report.ts'
import type {
  StreamChunk,
} from '../stream/chunk.ts'
import {
  createModelCallHandle,
} from './model-call-handle.ts'
import {
  normalizeResolvedModelInfo, validateCatalogModels, validateModelCatalogSnapshot,
} from './model-metadata.ts'
import type {
  PreparedDispatch,
} from './model-stream.ts'
import {
  type AdapterRegistrationHandle, type ModelProviderPlugin, type PluginRegistrationHandle, type StreamMiddleware,
} from '../plugin/provider-plugin.ts'

import {
  positiveSafeInteger, registrationEvidence, validateRuntimeDefaults,
} from './registry-support.ts'

import {
  createRegistryStream,
} from './registry-dispatch.ts'
import {
  prepareRegistryCall, type PreparedCall,
} from './registry-call.ts'
export type { PreparedCall } from './registry-call.ts'

export type { AdapterRegistrationHandle, StreamMiddleware } from '../plugin/provider-plugin.ts'

/**
 * Wraps every streaming model call. Call `next()` to reach the adapter, or yield
 * your own chunks to short-circuit it entirely.
 *
 * This is the extension point for retry, caching, request logging, replay, and
 * test doubles. Middleware registered EARLIER sits further out.
 */
export interface ModelRegistryOptions {
  /** Maximum model rows accepted from one adapter catalog. Defaults to 2,048. */
  readonly maxCatalogModels?: number
  /** Maximum serialized bytes accepted from a catalog or model-info record. Defaults to 4 MiB. */
  readonly maxCatalogBytes?: number
  /** Default observation port; a per-call invocation context may override it. */
  readonly observation?: ObservationPort
  /** Safe SDK/service/runtime identity copied onto observation events. */
  readonly observationResource?: ObservationResource
  /**
   * SDK-wide fallbacks (context window, output cap, accepted modalities) used
   * only when neither a model nor its route names one. See {@link RuntimeDefaults}.
   */
  readonly defaults?: RuntimeDefaults
}

/**
 * Routes model calls to registered adapters.
 *
 * Construct one per application or isolated runtime scope, register the adapters
 * you use, then call {@link stream} or {@link prepareCall}.
 */
export class ModelRegistry {
  private readonly routes = new RegistryRoutes()
  private middleware: StreamMiddleware[] = []

  private readonly maxCatalogModels: number
  private readonly maxCatalogBytes: number
  private readonly observation: ObservationPort | undefined
  private readonly observationResource: ObservationResource
  private readonly defaults: RuntimeDefaults

  constructor(options: ModelRegistryOptions = {}) {
    this.maxCatalogModels = positiveSafeInteger(options.maxCatalogModels ?? 2_048, 'maxCatalogModels')
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes')
    this.observation = options.observation
    this.defaults = validateRuntimeDefaults(options.defaults ?? {})
    this.observationResource = deepFreeze(options.observationResource ?? {
      sdkName: 'ai-agent-sdk',
      sdkVersion: SDK_VERSION,
      runtime: 'unknown',
    })
  }

  /** Install one provider plugin as a single synchronous topology transaction. */
  install(plugin: ModelProviderPlugin): PluginRegistrationHandle {
    return this.routes.install(plugin, this.middleware)
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
  registerAdapter(providers: readonly string[], adapter: ModelAdapter): AdapterRegistrationHandle {
    return this.routes.registerAdapter(providers, adapter)
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
    return this.routes.onAdaptersUpdated(listener)
  }

  /**
   * Describe every route with a registered adapter.
   * @returns detached provider metadata, in registration order.
   */
  listProviders(): ProviderInfo[] { return this.routes.listProviders() }

  /**
   * List the models one route advertises.
   *
   * Re-validated here rather than trusted, because a malformed catalog entry
   * surfaces in a caller's model picker where its origin is far from obvious.
   * @param provider - a registered route.
   * @returns detached, validated model metadata.
   */
  async listModels(provider: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const registration = this.routes.registration(provider)
    const models = await registration.adapter.listModels(provider, signal)
    return validateCatalogModels(provider, models, this.maxCatalogModels, this.maxCatalogBytes)
  }

  /** Resolve and validate one uncached adapter-level catalog generation. */
  async modelCatalog(provider: string, options: ModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    const registration = this.routes.registration(provider)
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
    const registration = this.routes.registration(provider)
    const resolved = await registration.adapter.resolveModel(provider, model, signal)
    return normalizeResolvedModelInfo(registration.provider.id, model, resolved,
      { maxBytes: this.maxCatalogBytes, defaults: this.defaults })
  }

  /** The retry policy captured for one route. */
  retryPolicy(provider: string): ResolvedRetryPolicy {
    return this.routes.registration(provider).retryPolicy
  }

  /**
   * Resolve one call under its CURRENT adapter registration, returning a one-shot
   * handle that keeps that registration through to dispatch.
   * @param config - route, model, and optional request controls.
   * @param signal - cancellation for adapter-side capability lookup.
   * @returns the prepared config and its registration-bound stream entry point.
   */
  prepareCall(
    config: CallConfig, signal?: AbortSignal, invocationContext?: ModelInvocationContext,
  ): Promise<PreparedCall> {
    return prepareRegistryCall(config, signal, invocationContext, {
      maxCatalogBytes: this.maxCatalogBytes, defaults: this.defaults,
      registration: provider => this.routes.registration(provider),
      dispatch: (options, context, prepared) => this.dispatch(options, context, prepared),
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
    const registration = prepared?.registration ?? this.routes.find(options.provider)
    return createModelCallHandle({
      options,
      ...registrationEvidence(registration),
      ...(context === undefined ? {} : { context }),
      ...(this.observation === undefined ? {} : { defaultObservation: this.observation }),
      resource: this.observationResource,
      routePresent: prepared !== undefined || this.routes.has(options.provider),
      dispatchState: () => dispatchState,
      stream: activeContext => this.dispatchRaw(
        options,
        activeContext,
        () => { dispatchState = 'unknown' },
        prepared,
      ),
    })
  }

  private dispatchRaw(
    options: GenerateOptions, context: ModelInvocationContext, onDispatch: () => void, prepared?: PreparedDispatch,
  ): AsyncIterable<StreamChunk> {
    return createRegistryStream(options, context, onDispatch, {
      chain: [...this.middleware], maxCatalogBytes: this.maxCatalogBytes, defaults: this.defaults, prepared,
      registration: provider => this.routes.registration(provider),
      registeredAdapter: provider => this.routes.find(provider)?.adapter,
    })
  }



}
