import type { ModelAdapter } from '../../contract/adapter.ts'
import type { SdkLogger } from '../../logging/types.ts'
import type { ModelProviderRegistrar, StreamMiddleware } from '../../plugin/provider-plugin.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText, capturedMethod, objectValue, ownData } from '../common/data.ts'
import { captureModelTarget } from './model-selection.ts'
import {
  PROVIDER_PLUGIN_API_VERSION, type ComposableModelProviderPlugin,
  type ComposableModelProviderRegistrar, type ModelProviderPluginDefinition,
  type ProviderPluginCleanupDefinition,
} from './types.ts'

/** Create an inert plugin wrapper; setup and cleanup remain deferred to runtime activation. */
export function defineModelProviderPlugin(
  definition: ModelProviderPluginDefinition,
): ComposableModelProviderPlugin {
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
    [ComposableModelProviderRegistrar], undefined | ProviderPluginCleanupDefinition
  >(source, 'setup')
  const claims = Object.freeze(routes)
  const setup = (registrar: ModelProviderRegistrar): void | (() => void) => {
    const logger = boundLogger(registrar)
    const scoped: ComposableModelProviderRegistrar = Object.freeze({
      logger,
      registerAdapter(adapter: ModelAdapter, selected: readonly string[] = claims) {
        return registrar.registerAdapter(selected, adapter)
      },
      use(middleware: StreamMiddleware) { return registrar.use(middleware) },
    })
    const cleanup = authorSetup(scoped)
    if (cleanup === undefined) return
    if (typeof cleanup !== 'function') return cleanup as never
    return () => { cleanup() }
  }
  return Object.freeze({
    kind: 'model-provider-plugin', apiVersion: PROVIDER_PLUGIN_API_VERSION,
    id, displayName, routes: claims, ...(family === undefined ? {} : { family }),
    ...(defaultModel === undefined ? {} : { defaultModel }), setup,
  })
}

function boundLogger(registrar: ModelProviderRegistrar): SdkLogger {
  const logger = Reflect.get(registrar, 'logger') as Partial<SdkLogger> | undefined
  if (logger === undefined || typeof logger.child !== 'function'
    || typeof logger.info !== 'function' || typeof logger.error !== 'function') {
    throw new TypeError('Composable provider setup requires a runtime-bound logger')
  }
  return logger as SdkLogger
}
