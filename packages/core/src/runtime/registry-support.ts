import type { ProviderInfo, RuntimeDefaults } from '../contract/model-info.ts'
import { ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import type { RuntimeAdapterRegistration } from './model-stream.ts'

export function validateAdapterInfo(provider: string, info: ProviderInfo): void {
  if (typeof info.id !== 'string' || info.id !== provider
    || typeof info.name !== 'string' || info.name.length === 0) {
    throw new ModelError(
      `adapter metadata for route "${provider}" must preserve its id and carry a non-empty name`,
      REGISTRY_ERROR_CODES.INVALID_ADAPTER,
    )
  }
}

export function registrationEvidence(registration: RuntimeAdapterRegistration | undefined) {
  return {
    ...(registration?.family === undefined ? {} : { providerFamily: registration.family }),
    ...(registration?.pluginId === undefined ? {} : { providerPluginId: registration.pluginId }),
    ...(registration === undefined ? {} : { isRetryable: (code: string) => (
      registration.retryPolicy.mode === 'always' || registration.retryPolicy.retryableCodes.includes(code)
    ) }),
  }
}

export function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`ModelRegistry ${label} must be a positive safe integer`)
  }
  return value
}

export function validateRuntimeDefaults(defaults: RuntimeDefaults): RuntimeDefaults {
  if (defaults.contextWindow !== undefined) positiveSafeInteger(defaults.contextWindow, 'defaults.contextWindow')
  if (defaults.maxTokens !== undefined) positiveSafeInteger(defaults.maxTokens, 'defaults.maxTokens')
  if (defaults.inputModalities !== undefined
    && (defaults.inputModalities.length === 0
      || new Set(defaults.inputModalities).size !== defaults.inputModalities.length)) {
    throw new RangeError('ModelRegistry defaults.inputModalities must be non-empty and unique')
  }
  return deepFreeze({
    ...(defaults.contextWindow === undefined ? {} : { contextWindow: defaults.contextWindow }),
    ...(defaults.maxTokens === undefined ? {} : { maxTokens: defaults.maxTokens }),
    ...(defaults.inputModalities === undefined ? {} : { inputModalities: [...defaults.inputModalities] }),
  })
}
