import {
  MAX_SKILL_RESOURCE_CHARS, defineSkill, skillSummary, validateSkillSource,
  type SkillCandidate, type SkillDefinition, type SkillDefinitionInput,
  type SkillProvider, type SkillSummary, type SkillLookupOptions, type SkillResourceSummary,
} from './definition.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { captureSkillProviderPlugin } from './provider/definition.ts'
import { capabilityIdentityError } from '../../errors/capability-identity.ts'
import { SKILL_ERROR_CODES, SKILL_PROVIDER_API_VERSION } from './provider/config.ts'
import type {
  ActivatedSkillSnapshot, CapturedSkillProviderPlugin, RuntimeSkillCandidate,
  RuntimeSkillSource, SkillReference,
} from './provider/types.ts'

export interface CatalogEntry {
  readonly summary: SkillSummary
  readonly direct?: SkillDefinition
  readonly provider?: SkillProvider
  readonly candidate?: SkillCandidate
  readonly runtimeProvider?: CapturedSkillProviderPlugin
  readonly reference?: SkillReference
}

export function summaryOfCandidate(candidate: SkillCandidate): SkillSummary {
  return Object.freeze({
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: Object.freeze({ ...candidate.invocation }),
    source: candidate.source,
    provider: candidate.provider,
    ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
  })
}

export function summaryOfRuntimeCandidate(candidate: RuntimeSkillCandidate): SkillSummary {
  return Object.freeze({
    id: candidate.id, name: candidate.name, description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: candidate.invocation ?? Object.freeze({ modelInvocable: true, userInvocable: true }),
    source: candidate.source, provider: candidate.provider,
  })
}

export function summaryFromReferenceInput(
  input: SkillDefinitionInput, reference: ActivatedSkillSnapshot,
): SkillSummary {
  return skillSummary(defineSkill({ ...input, id: reference.id, source: reference.source,
    provider: reference.provider }))
}

export function captureCatalogSources(sources: readonly RuntimeSkillSource[]): readonly RuntimeSkillSource[] {
  const captured = sources.map(source => {
    if (source.kind === 'skill') { validateSkillSource(source); return source }
    const descriptor = Object.getOwnPropertyDescriptor(source, 'apiVersion')
    if (descriptor === undefined) {
      validateSkillSource(source as SkillProvider)
      return source
    }
    if (!('value' in descriptor)) throw referenceInvalid()
    return captureSkillProviderPlugin(source)
  })
  const ids = new Map<string, number>()
  for (const [index, source] of captured.entries()) {
    if (source.kind === 'skill') continue
    const first = ids.get(source.id)
    if (first !== undefined) throw capabilityIdentityError(
      'SKILL_PROVIDER_ID_CONFLICT', 'skill-provider-id', first, index,
    )
    ids.set(source.id, index)
  }
  return Object.freeze(captured)
}

export function isRuntimeProvider(source: RuntimeSkillSource): source is CapturedSkillProviderPlugin {
  return source.kind === 'skill-provider'
    && Object.getOwnPropertyDescriptor(source, 'apiVersion')?.value === SKILL_PROVIDER_API_VERSION
}

export function referenceOnly(value: ActivatedSkillSnapshot): SkillReference {
  return Object.freeze({ id: value.id, source: value.source, provider: value.provider,
    catalogRevision: value.catalogRevision,
    ...(value.locator === undefined ? {} : { locator: value.locator }) })
}

export function validateResourceContent(content: string | undefined, path: string): string | undefined {
  if (content === undefined) return undefined
  if (typeof content !== 'string') throw new TypeError(`skill provider returned a non-text resource '${path}'`)
  if (content.length > MAX_SKILL_RESOURCE_CHARS) {
    throw new RangeError(`skill resource '${path}' exceeds ${MAX_SKILL_RESOURCE_CHARS} characters`)
  }
  return content
}

export function referenceInvalid(): AgentSdkError {
  return new AgentSdkError('Persisted skill reference is invalid', SKILL_ERROR_CODES.REFERENCE_INVALID)
}

export function referenceUnavailable(): AgentSdkError {
  return new AgentSdkError('Persisted skill reference is unavailable', SKILL_ERROR_CODES.REFERENCE_UNAVAILABLE)
}

export function addUnique(
  entries: Map<string, CatalogEntry>,
  id: string,
  entry: CatalogEntry,
): void {
  const existing = entries.get(id)
  if (existing !== undefined) {
    throw capabilityIdentityError(
      'SKILL_ID_CONFLICT', 'skill-id', [...entries.keys()].indexOf(id), entries.size,
    )
  }
  entries.set(id, entry)
}

export function freezeSummaries(entries: ReadonlyMap<string, CatalogEntry>): readonly SkillSummary[] {
  return Object.freeze([...entries.values()].map(entry => entry.summary)
    .sort((left, right) => left.id.localeCompare(right.id)))
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('skill discovery aborted')
}

export function addCatalogBytes(total: number, value: unknown, maxBytes: number): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('skill catalog entry is not JSON serializable')
  const next = total + new TextEncoder().encode(serialized).byteLength
  if (next > maxBytes) throw new RangeError(`skill catalog exceeds ${maxBytes} serialized bytes`)
  return next
}

export function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error('skill discovery aborted')) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

export async function loadLegacyEntry(
  id: string, entry: CatalogEntry | undefined, options: SkillLookupOptions,
): Promise<SkillDefinition | undefined> {
  if (entry?.provider === undefined || entry.candidate === undefined) return undefined
  const input = await raceAbort(entry.provider.load(entry.candidate, options), options.signal)
  throwIfAborted(options.signal)
  if (input === undefined) return undefined
  const resourceBase = input.resourceBase ?? entry.summary.resourceBase
  const resolved = defineSkill({
    ...input,
    source: entry.summary.source,
    provider: entry.provider.id,
    invocation: entry.summary.invocation,
    ...(resourceBase === undefined ? {} : { resourceBase }),
  })
  if (resolved.id !== id) {
    throw new TypeError(`skill provider '${entry.provider.id}' loaded '${resolved.id}' for candidate '${id}'`)
  }
  return resolved
}

export function needsResourceHydration(
  entry: CatalogEntry | undefined, manifest: readonly SkillResourceSummary[] | undefined,
): boolean {
  return manifest === undefined || entry?.provider?.readResource === undefined
}

export async function readLegacyResource(
  entry: CatalogEntry | undefined, path: string, options: SkillLookupOptions,
): Promise<string | undefined> {
  if (entry?.provider?.readResource === undefined || entry.candidate === undefined) return undefined
  const content = await raceAbort(
    entry.provider.readResource(entry.candidate, path, options), options.signal,
  )
  if (content === undefined) return undefined
  if (typeof content !== 'string') {
    throw new TypeError(`skill provider '${entry.provider.id}' returned a non-text resource '${path}'`)
  }
  if (content.length > MAX_SKILL_RESOURCE_CHARS) {
    throw new RangeError(`skill resource '${path}' exceeds ${MAX_SKILL_RESOURCE_CHARS} characters`)
  }
  return content
}
