import type { EmbeddingAdapter } from '../../embedding/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText, capturedMethod, objectValue, ownData } from '../common/data.ts'
import { captureModelTarget } from '../provider/model-selection.ts'
import {
  EMBEDDING_PROVIDER_PLUGIN_API_VERSION, type ComposableEmbeddingProviderPlugin,
  type ComposableEmbeddingProviderRegistrar, type EmbeddingProviderPluginCleanupDefinition,
  type EmbeddingProviderPluginDefinition, type EmbeddingProviderRegistrar,
} from './plugin-types.ts'

/** Create an inert embedding plugin wrapper; setup and cleanup stay deferred to activation. */
export function defineEmbeddingProviderPlugin(
  definition: EmbeddingProviderPluginDefinition,
): ComposableEmbeddingProviderPlugin {
  const source = objectValue(definition)
  const id = boundedText(ownData(source, 'id'), COMPOSITION_LIMITS.identityBytes)
  const displayName = boundedText(ownData(source, 'displayName'), COMPOSITION_LIMITS.displayNameBytes)
  const familyValue = ownData(source, 'family', false)
  const family = familyValue === undefined ? undefined
    : boundedText(familyValue, COMPOSITION_LIMITS.identityBytes)
  const routes = arrayData(ownData(source, 'routes'), COMPOSITION_LIMITS.routesPerProvider)
    .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
  if (routes.length === 0 || new Set(routes).size !== routes.length) {
    throw new TypeError('Provider route claims must be non-empty and unique')
  }
  const defaultValue = ownData(source, 'defaultModel', false)
  const defaultModel = defaultValue === undefined ? undefined : captureModelTarget(defaultValue, false)
  if (defaultModel !== undefined && !routes.includes(defaultModel.provider)) {
    throw new TypeError('Provider default model route is not claimed')
  }
  const authorSetup = capturedMethod<
    [ComposableEmbeddingProviderRegistrar], undefined | EmbeddingProviderPluginCleanupDefinition
  >(source, 'setup')
  const claims = Object.freeze(routes)
  const setup = (registrar: EmbeddingProviderRegistrar): void | (() => void) => {
    const logger = boundLogger(registrar)
    const scoped: ComposableEmbeddingProviderRegistrar = Object.freeze({
      logger,
      registerEmbeddingAdapter(
        adapter: EmbeddingAdapter,
        options?: { readonly routes?: readonly string[]; readonly models?: readonly string[] },
      ) {
        const selected = options?.routes === undefined ? claims : capturedRoutes(options.routes, claims)
        const models = options?.models === undefined ? undefined : capturedModels(options.models)
        return registrar.registerEmbeddingAdapter(selected, adapter, models)
      },
    })
    const cleanup = authorSetup(scoped)
    if (cleanup === undefined) return
    if (typeof cleanup !== 'function') return cleanup as never
    return () => { cleanup() }
  }
  return Object.freeze({
    kind: 'embedding-provider-plugin', apiVersion: EMBEDDING_PROVIDER_PLUGIN_API_VERSION,
    id, displayName, routes: claims, ...(family === undefined ? {} : { family }),
    ...(defaultModel === undefined ? {} : { defaultModel }), setup,
  })
}

/** Registration cannot reach outside the predeclared claims (Requirement 11.5). */
function capturedRoutes(
  value: readonly string[],
  claims: readonly string[],
): readonly string[] {
  const selected = arrayData(value, COMPOSITION_LIMITS.routesPerProvider)
    .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
  if (selected.length === 0 || new Set(selected).size !== selected.length) {
    throw new TypeError('Embedding adapter route selection must be non-empty and unique')
  }
  for (const route of selected) {
    if (!claims.includes(route)) {
      throw new TypeError('Embedding adapter route is not claimed by this plugin')
    }
  }
  return Object.freeze(selected)
}

function capturedModels(value: readonly string[]): readonly string[] {
  const models = arrayData(value, COMPOSITION_LIMITS.routesPerProvider)
    .map(model => boundedText(model, COMPOSITION_LIMITS.modelIdBytes))
  if (models.length === 0 || new Set(models).size !== models.length) {
    throw new TypeError('Embedding adapter model selection must be non-empty and unique')
  }
  return Object.freeze(models)
}

function boundLogger(registrar: EmbeddingProviderRegistrar): SdkLogger {
  const logger = Reflect.get(registrar, 'logger') as Partial<SdkLogger> | undefined
  if (logger === undefined || typeof logger.child !== 'function'
    || typeof logger.info !== 'function' || typeof logger.error !== 'function') {
    throw new TypeError('Composable embedding provider setup requires a runtime-bound logger')
  }
  return logger as SdkLogger
}
