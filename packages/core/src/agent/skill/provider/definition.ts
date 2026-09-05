import { AgentSdkError } from '../../../errors/agent-sdk-error.ts'
import { arrayData, boundedText, objectValue, ownData } from '../../../capability/common/data.ts'
import { capabilityIdentityError } from '../../../errors/capability-identity.ts'
import { runCoreCapabilityMaybeAsync } from '../../../platform/capability-operation.ts'
import { validateSkillId, validateSkillSource, type SkillProvider } from '../definition.ts'
import {
  SKILL_PROVIDER_API_VERSION, SKILL_PROVIDER_ERROR_CODES, SKILL_PROVIDER_LIMITS,
} from './config.ts'
import type {
  CapturedSkillProviderPlugin, SkillCatalogSnapshot, SkillProviderPlugin,
  SkillProviderPluginDefinition, SkillReference, RuntimeSkillLookupOptions,
  RuntimeSkillSource,
} from './types.ts'

type SkillResourceResult = ReturnType<NonNullable<SkillProviderPlugin['readResource']>>

export function defineSkillProviderPlugin(
  provider: SkillProviderPluginDefinition,
): SkillProviderPlugin {
  return captureSkillProviderPlugin(provider, false)
}

export function captureSkillProviderPlugin(
  value: unknown,
  requireMarker = true,
): CapturedSkillProviderPlugin {
  try {
    const source = objectValue(value)
    if (requireMarker) {
      if (ownData(source, 'kind') !== 'skill-provider') throw new AgentSdkError(
        'Skill provider kind is unsupported', SKILL_PROVIDER_ERROR_CODES.KIND_MISMATCH,
      )
      if (ownData(source, 'apiVersion') !== SKILL_PROVIDER_API_VERSION) throw new AgentSdkError(
        'Skill provider API version is unsupported', SKILL_PROVIDER_ERROR_CODES.API_UNSUPPORTED,
      )
    }
    const id = boundedText(ownData(source, 'id'), SKILL_PROVIDER_LIMITS.identityBytes)
    validateSkillId(id, 'skill provider')
    const listMethod = method(source, 'list', true)
    const loadMethod = method(source, 'load', true)
    const resourceMethod = method(source, 'readResource', false)
    const list = (options: RuntimeSkillLookupOptions & { readonly allowedSkillIds?: readonly string[] }) =>
      runCoreCapabilityMaybeAsync(options.logger, 'core-skill-provider', 'list', options.signal,
        () => Reflect.apply(listMethod!, source, [options]) as Promise<SkillCatalogSnapshot>)
    const load = (reference: SkillReference, options: RuntimeSkillLookupOptions) =>
      runCoreCapabilityMaybeAsync(options.logger, 'core-skill-provider', 'load', options.signal,
        () => Reflect.apply(loadMethod!, source, [reference, options]) as ReturnType<SkillProviderPlugin['load']>)
    const readResource = resourceMethod === undefined ? undefined
      : (reference: SkillReference, path: string, options: RuntimeSkillLookupOptions) =>
        runCoreCapabilityMaybeAsync(options.logger, 'core-skill-provider', 'read-resource', options.signal,
          () => Reflect.apply(resourceMethod, source, [reference, path, options]) as SkillResourceResult)
    return Object.freeze({ kind: 'skill-provider', apiVersion: SKILL_PROVIDER_API_VERSION,
      id, list, load, ...(readResource === undefined ? {} : { readResource }) })
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw new AgentSdkError('Skill provider definition is invalid', SKILL_PROVIDER_ERROR_CODES.DEFINITION_INVALID)
  }
}

export function captureSkillProviderPlugins(value: unknown): readonly CapturedSkillProviderPlugin[] {
  if (value === undefined) return Object.freeze([])
  const providers = arrayData(value, SKILL_PROVIDER_LIMITS.providers)
    .map(entry => captureSkillProviderPlugin(entry))
  const seen = new Map<string, number>()
  for (const [index, provider] of providers.entries()) {
    const first = seen.get(provider.id)
    if (first !== undefined) throw capabilityIdentityError(
      SKILL_PROVIDER_ERROR_CODES.ID_CONFLICT, 'skill-provider-id', first, index,
    )
    seen.set(provider.id, index)
  }
  return Object.freeze(providers)
}

export function captureRuntimeSkillSources(value: unknown): readonly RuntimeSkillSource[] {
  if (value === undefined) return Object.freeze([])
  const entries = arrayData(value, SKILL_PROVIDER_LIMITS.providers)
  const sources = entries.map(entry => {
    const source = objectValue(entry)
    const kind = ownData(source, 'kind')
    if (kind === 'skill') {
      validateSkillSource(source as RuntimeSkillSource & { readonly kind: 'skill' })
      return source as RuntimeSkillSource
    }
    if (kind !== 'skill-provider') throw new AgentSdkError(
      'Skill provider kind is unsupported', SKILL_PROVIDER_ERROR_CODES.KIND_MISMATCH,
    )
    const version = ownData(source, 'apiVersion', false)
    if (version === undefined) {
      validateSkillSource(source as SkillProvider)
      return source as RuntimeSkillSource
    }
    return captureSkillProviderPlugin(source)
  })
  const providers = sources.filter(source => source.kind === 'skill-provider')
  const ids = new Map<string, number>()
  for (const [index, provider] of providers.entries()) {
    const first = ids.get(provider.id)
    if (first !== undefined) throw capabilityIdentityError(
      SKILL_PROVIDER_ERROR_CODES.ID_CONFLICT, 'skill-provider-id', first, index,
    )
    ids.set(provider.id, index)
  }
  return Object.freeze(sources)
}

function method(value: object, key: string, required: boolean): Function | undefined {
  let result: unknown
  try { result = Reflect.get(value, key) } catch { throw new TypeError('Method capture failed') }
  if (result === undefined && !required) return undefined
  if (typeof result !== 'function') throw new TypeError('Method is invalid')
  return result
}
