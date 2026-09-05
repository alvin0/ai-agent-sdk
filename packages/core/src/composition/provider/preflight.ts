import type { ModelProviderRegistrar } from '../../plugin/provider-plugin.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData, boundedText, capturedMethod, objectValue, ownData } from '../common/data.ts'
import { checkPreflightAbort, invalidPreflight } from '../common/errors.ts'
import type { CapabilityIdentityConflict } from '../common/errors.ts'
import { capabilityIdentityConflict } from '../identity/error.ts'
import { captureModelTarget } from './model-selection.ts'
import { PROVIDER_PLUGIN_API_VERSION, type CapturedProvider, type ProviderMetadata, type ProviderSelection } from './types.ts'

/** Internal phase token: identity validation is separate from executable method capture. */
export interface ProviderIdentityPlan extends ProviderSelection {}
const sourcesByPlan = new WeakMap<ProviderIdentityPlan, readonly object[]>()
const methodsByPlan = new WeakMap<ProviderIdentityPlan, readonly CapturedProvider[]>()

function conflict(namespace: CapabilityIdentityConflict['namespace'], firstIndex: number, secondIndex: number) {
  return invalidPreflight(namespace === 'provider-route' ? 'PROVIDER_ROUTE_CONFLICT' : 'CAPABILITY_ID_CONFLICT',
    capabilityIdentityConflict(namespace, firstIndex, secondIndex))
}

function metadata(source: object): ProviderMetadata {
  const id = boundedText(ownData(source, 'id'), COMPOSITION_LIMITS.identityBytes)
  const displayName = boundedText(ownData(source, 'displayName'), COMPOSITION_LIMITS.displayNameBytes)
  const rawFamily = ownData(source, 'family', false)
  const family = rawFamily === undefined ? id : boundedText(rawFamily, COMPOSITION_LIMITS.identityBytes)
  const routes = arrayData(ownData(source, 'routes'), COMPOSITION_LIMITS.routesPerProvider)
    .map(route => boundedText(route, COMPOSITION_LIMITS.identityBytes))
  if (routes.length === 0) throw invalidPreflight()
  const rawDefault = ownData(source, 'defaultModel', false)
  const defaultModel = rawDefault === undefined ? undefined : captureModelTarget(rawDefault, false)
  if (defaultModel !== undefined && !routes.includes(defaultModel.provider)) throw invalidPreflight()
  return Object.freeze({
    id, displayName, family, routes: Object.freeze(routes),
    ...(defaultModel === undefined ? {} : { defaultModel }),
  })
}

/** No setup lookup, allocation, registration, discovery, or ownership transfer in this phase. */
export function preflightProviderIdentities(
  input: unknown,
  defaultProvider?: unknown,
  signal?: AbortSignal,
): ProviderIdentityPlan {
  checkPreflightAbort(signal)
  const failures = new Set<unknown>()
  // Retain only errors we created; never trust a foreign exception's shape/code/message.
  const fail = (error: Error): never => { failures.add(error); throw error }
  try {
    const sources = arrayData(input, COMPOSITION_LIMITS.providers).map(objectValue)
    const providers: ProviderMetadata[] = []
    const ids = new Map<string, number>()
    const routes = new Map<string, number>()
    for (const [index, source] of sources.entries()) {
      checkPreflightAbort(signal)
      // Marker comparisons are done here so foreign property-access exceptions are never passed through.
      if (ownData(source, 'kind', false) !== 'model-provider-plugin') fail(invalidPreflight('CAPABILITY_KIND_MISMATCH'))
      if (ownData(source, 'apiVersion', false) !== PROVIDER_PLUGIN_API_VERSION) fail(invalidPreflight('CAPABILITY_API_UNSUPPORTED'))
      const provider = metadata(source)
      const previous = ids.get(provider.id)
      if (previous !== undefined) fail(conflict('provider-plugin-id', previous, index))
      ids.set(provider.id, index)
      for (const route of provider.routes) {
        const first = routes.get(route)
        if (first !== undefined) fail(conflict('provider-route', first, index))
        routes.set(route, index)
      }
      providers.push(provider)
    }
    const selected = defaultProvider === undefined ? undefined
      : boundedText(defaultProvider, COMPOSITION_LIMITS.identityBytes)
    if (selected !== undefined && !providers.some(provider => provider.defaultModel?.provider === selected)) {
      fail(invalidPreflight())
    }
    checkPreflightAbort(signal)
    const plan: ProviderIdentityPlan = Object.freeze({
      providers: Object.freeze(providers), ...(selected === undefined ? {} : { defaultProvider: selected }),
    })
    sourcesByPlan.set(plan, Object.freeze(sources))
    return plan
  } catch (error) {
    if (signal?.aborted) checkPreflightAbort(signal)
    if (failures.has(error)) throw error
    throw invalidPreflight()
  }
}

/** Call only after ALL runtime identity namespaces (including exporters) have passed preflight. */
export function captureProviderMethods(plan: ProviderIdentityPlan, signal?: AbortSignal): readonly CapturedProvider[] {
  checkPreflightAbort(signal)
  const captured = methodsByPlan.get(plan)
  if (captured !== undefined) return captured
  const sources = sourcesByPlan.get(plan)
  if (sources === undefined) throw invalidPreflight()
  // A failed capture is terminal too: never reread a partially observed method table.
  sourcesByPlan.delete(plan)
  try {
    const result = plan.providers.map((provider, index) => {
      checkPreflightAbort(signal)
      const setup = capturedMethod<[ModelProviderRegistrar], void | (() => void)>(sources[index]!, 'setup')
      return Object.freeze({ ...provider, setup })
    })
    checkPreflightAbort(signal)
    const captured = Object.freeze(result)
    methodsByPlan.set(plan, captured)
    return captured
  } catch {
    checkPreflightAbort(signal)
    throw invalidPreflight()
  }
}
