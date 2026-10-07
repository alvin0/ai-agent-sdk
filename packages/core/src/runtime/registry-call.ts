import { callConfigEquals, type CallConfig, type CallConfigAdapterDefaults } from '../contract/call-config.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type { ModelContext, ModelModality, ResolvedModelInfo, RuntimeDefaults } from '../contract/model-info.ts'
import type { ResolvedRetryPolicy } from '../contract/retry-policy.ts'
import { ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import type { ModelCallHandle, ModelInvocationContext } from '../observation/report.ts'
import { normalizeResolvedModelInfo, resolveCallWithModelInfo } from './model-metadata.ts'
import type { PreparedDispatch, RuntimeAdapterRegistration } from './model-stream.ts'

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

interface PreparedCallHost {
  readonly maxCatalogBytes: number
  readonly defaults: RuntimeDefaults
  registration(provider: string): RuntimeAdapterRegistration
  dispatch(options: GenerateOptions, context: ModelInvocationContext | undefined,
    prepared: PreparedDispatch): ModelCallHandle
}

export async function prepareRegistryCall(
  config: CallConfig, signal: AbortSignal | undefined,
  invocationContext: ModelInvocationContext | undefined, host: PreparedCallHost,
): Promise<PreparedCall> {
  const registration = host.registration(config.provider)
  const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal, invocationContext)
  const modelInfo = normalizeResolvedModelInfo(
    registration.provider.id, config.model, adapterCall.model,
    { maxBytes: host.maxCatalogBytes, defaults: host.defaults },
  )
  const resolved = resolveCallWithModelInfo(config, modelInfo, host.defaults)
  const resolvedConfig = deepFreeze(structuredClone(resolved.config))
  const context = resolved.context === undefined
    ? undefined
    : deepFreeze(structuredClone(resolved.context))
  const adapterDefaults = deepFreeze<CallConfigAdapterDefaults>({
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
    ...resolved.inputModalities === undefined
      ? {}
      : { inputModalities: Object.freeze([...resolved.inputModalities]) },
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
      return host.dispatch(options, context, {
        registration,
        config: resolvedConfig,
        modelInfo,
        dispatch: (request, activeContext) => adapterCall.stream(request, activeContext),
      })
    },
  })
}
