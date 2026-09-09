import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { COMPOSITION_LIMITS, MODEL_BINDING_ERROR_CODES } from '../common/config.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import type { ModelTarget, ProviderSelection, RuntimeProviderInfo } from './types.ts'

export function captureModelTarget(value: unknown, allowRouteOnly: false): ModelTarget
export function captureModelTarget(value: unknown, allowRouteOnly: true): { readonly provider: string; readonly id?: string }
export function captureModelTarget(value: unknown, allowRouteOnly: boolean) {
  const input = objectValue(value)
  if (Reflect.ownKeys(input).some(key => key !== 'provider' && key !== 'id')) {
    throw new TypeError('Model target contains unsupported fields')
  }
  const provider = boundedText(ownData(input, 'provider'), COMPOSITION_LIMITS.identityBytes)
  const descriptor = Object.getOwnPropertyDescriptor(input, 'id')
  if (descriptor !== undefined && !('value' in descriptor)) throw new TypeError('Model ID must be data')
  const id = descriptor === undefined && allowRouteOnly
    ? undefined : boundedText(descriptor?.value, COMPOSITION_LIMITS.modelIdBytes)
  return Object.freeze({ provider, ...(id === undefined ? {} : { id }) })
}

/** No discovery or error-time failover: only explicit targets and captured omission defaults. */
export function resolveAgentModel(selection: ProviderSelection, input?: unknown): ModelTarget {
  let target: { readonly provider: string; readonly id?: string } | undefined
  try { target = input === undefined ? undefined : captureModelTarget(input, true) }
  catch { throw new AgentSdkError('Agent model target is invalid', MODEL_BINDING_ERROR_CODES.INVALID) }
  const route = target?.provider ?? selection.defaultProvider
  if (route !== undefined) {
    const owner = selection.providers.find(provider => provider.routes.includes(route))
    if (owner === undefined) throw new AgentSdkError('Agent model route is unavailable', MODEL_BINDING_ERROR_CODES.UNKNOWN_ROUTE)
    if (target?.id !== undefined) return Object.freeze({ provider: route, id: target.id })
    if (owner.defaultModel?.provider === route) return Object.freeze({ ...owner.defaultModel })
    throw new AgentSdkError('Selected route has no configured model default', MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT)
  }
  const defaults = selection.providers.flatMap(provider => provider.defaultModel === undefined ? [] : [provider.defaultModel])
  if (defaults.length === 0) throw new AgentSdkError('Agent model requires an explicit target or default', MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT)
  if (defaults.length !== 1) throw new AgentSdkError('Agent model defaults are ambiguous', MODEL_BINDING_ERROR_CODES.AMBIGUOUS_DEFAULT)
  return Object.freeze({ ...defaults[0]! })
}

export function providerTopology(selection: ProviderSelection): readonly RuntimeProviderInfo[] {
  return Object.freeze(selection.providers.flatMap(provider => provider.routes.map(route => Object.freeze({
    id: route, route, name: provider.displayName, pluginId: provider.id, family: provider.family,
    ...(provider.defaultModel?.provider === route ? { defaultModel: Object.freeze({ ...provider.defaultModel }) } : {}),
  }))))
}
