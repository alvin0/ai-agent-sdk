import { AgentSdkError } from '../../../errors/agent-sdk-error.ts'
import { snapshotJsonValue } from '../../../primitives/json-snapshot.ts'
import type { JsonValue } from '../../../primitives/index.ts'
import { arrayData, boundedText, objectValue, ownData } from '../../../capability/common/data.ts'
import { capabilityIdentityError } from '../../../errors/capability-identity.ts'
import {
  MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_NAME_CHARS, validateSkillId,
  type SkillResourceBase,
} from '../definition.ts'
import { SKILL_ERROR_CODES, SKILL_PROVIDER_LIMITS } from './config.ts'
import type {
  ActivatedSkillSnapshot, CapturedSkillProviderPlugin, RuntimeSkillCandidate,
  SkillReference,
} from './types.ts'

const CANDIDATE_KEYS = new Set([
  'id', 'name', 'description', 'whenToUse', 'invocation', 'source', 'provider', 'locator',
])
const REFERENCE_KEYS = new Set(['id', 'source', 'provider', 'catalogRevision', 'locator', 'resourceBase'])

export interface CapturedSkillCatalogSnapshot {
  readonly revision: string
  readonly candidates: readonly RuntimeSkillCandidate[]
  readonly references: readonly SkillReference[]
}

export function captureSkillCatalogSnapshot(
  provider: CapturedSkillProviderPlugin,
  value: unknown,
  maxSkills: number,
  maxBytes: number,
): CapturedSkillCatalogSnapshot {
  try {
    const source = objectValue(value)
    exactKeys(source, new Set(['revision', 'candidates']))
    const revision = boundedText(ownData(source, 'revision'), SKILL_PROVIDER_LIMITS.revisionBytes)
    const entries = arrayData(ownData(source, 'candidates'), maxSkills)
    const candidates = entries.map(entry => captureCandidate(entry, provider.id))
    const ids = new Map<string, number>()
    for (const [index, candidate] of candidates.entries()) {
      const first = ids.get(candidate.id)
      if (first !== undefined) throw capabilityIdentityError(
        SKILL_ERROR_CODES.ID_CONFLICT, 'skill-id', first, index,
      )
      ids.set(candidate.id, index)
    }
    const references = candidates.map(candidate => referenceFromCandidate(candidate, revision))
    const captured = Object.freeze({
      revision, candidates: Object.freeze(candidates), references: Object.freeze(references),
    })
    if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > maxBytes) throw invalidCatalog()
    return captured
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw invalidCatalog()
  }
}

export function captureSkillReference(value: unknown): ActivatedSkillSnapshot {
  try {
    const source = objectValue(value)
    exactKeys(source, REFERENCE_KEYS)
    const id = text(ownData(source, 'id'), MAX_SKILL_NAME_CHARS)
    validateSkillId(id)
    const provider = text(ownData(source, 'provider'), SKILL_PROVIDER_LIMITS.identityBytes)
    validateSkillId(provider, 'skill provider')
    return Object.freeze({
      id,
      source: text(ownData(source, 'source'), MAX_SKILL_NAME_CHARS),
      provider,
      catalogRevision: boundedText(ownData(source, 'catalogRevision'), SKILL_PROVIDER_LIMITS.revisionBytes),
      ...captureOptionalLocator(source),
      ...captureResourceBase(source),
    })
  } catch (error) {
    if (error instanceof AgentSdkError && error.code === SKILL_ERROR_CODES.REFERENCE_INVALID) throw error
    throw invalidReference()
  }
}

function captureCandidate(value: unknown, providerId: string): RuntimeSkillCandidate {
  const source = objectValue(value)
  exactKeys(source, CANDIDATE_KEYS)
  const id = text(ownData(source, 'id'), MAX_SKILL_NAME_CHARS)
  validateSkillId(id)
  const provider = text(ownData(source, 'provider'), SKILL_PROVIDER_LIMITS.identityBytes)
  if (provider !== providerId) throw invalidCatalog()
  const invocation = captureInvocation(ownData(source, 'invocation', false))
  return Object.freeze({
    id, name: text(ownData(source, 'name'), MAX_SKILL_NAME_CHARS),
    description: text(ownData(source, 'description'), MAX_SKILL_DESCRIPTION_CHARS),
    ...optionalText(source, 'whenToUse', MAX_SKILL_DESCRIPTION_CHARS),
    ...(invocation === undefined ? {} : { invocation }),
    source: text(ownData(source, 'source'), MAX_SKILL_NAME_CHARS), provider,
    ...captureOptionalLocator(source),
  })
}

function referenceFromCandidate(candidate: RuntimeSkillCandidate, revision: string): SkillReference {
  return Object.freeze({ id: candidate.id, source: candidate.source, provider: candidate.provider,
    catalogRevision: revision, ...(candidate.locator === undefined ? {} : { locator: candidate.locator }) })
}

function captureOptionalLocator(source: object): { readonly locator?: JsonValue } {
  const locator = ownData(source, 'locator', false)
  return locator === undefined ? {} : { locator: snapshotJsonValue(locator, {
    maxObjectFields: SKILL_PROVIDER_LIMITS.locatorFields,
    maxArrayItems: SKILL_PROVIDER_LIMITS.locatorArrayItems,
    maxDepth: SKILL_PROVIDER_LIMITS.locatorDepth,
    maxNodes: SKILL_PROVIDER_LIMITS.locatorNodes,
    maxKeyBytes: SKILL_PROVIDER_LIMITS.locatorKeyBytes,
    maxBytes: SKILL_PROVIDER_LIMITS.locatorBytes,
  }) }
}

function captureInvocation(value: unknown): RuntimeSkillCandidate['invocation'] {
  if (value === undefined) return undefined
  const source = objectValue(value)
  exactKeys(source, new Set(['modelInvocable', 'userInvocable']))
  const modelInvocable = ownData(source, 'modelInvocable')
  const userInvocable = ownData(source, 'userInvocable')
  if (typeof modelInvocable !== 'boolean' || typeof userInvocable !== 'boolean') throw invalidCatalog()
  return Object.freeze({ modelInvocable, userInvocable })
}

function captureResourceBase(source: object): { readonly resourceBase?: SkillResourceBase } {
  const value = ownData(source, 'resourceBase', false)
  if (value === undefined) return {}
  const base = objectValue(value)
  exactKeys(base, new Set(['kind', 'value']))
  const kind = ownData(base, 'kind')
  if (kind !== 'directory' && kind !== 'url' && kind !== 'opaque') throw invalidReference()
  return { resourceBase: Object.freeze({
    kind, value: text(ownData(base, 'value'), SKILL_PROVIDER_LIMITS.locatorBytes),
  }) }
}

function optionalText(source: object, key: string, max: number): { readonly [key: string]: string } {
  const value = ownData(source, key, false)
  return value === undefined ? {} : { [key]: text(value, max) }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max
    || new TextEncoder().encode(value).byteLength > max) throw new TypeError('Invalid skill text')
  return value
}

function exactKeys(value: object, allowed: ReadonlySet<string>): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Unsupported skill field')
  }
}

function invalidCatalog(): AgentSdkError {
  return new AgentSdkError('Skill catalog snapshot is invalid', SKILL_ERROR_CODES.CATALOG_INVALID)
}

function invalidReference(): AgentSdkError {
  return new AgentSdkError('Persisted skill reference is invalid', SKILL_ERROR_CODES.REFERENCE_INVALID)
}
