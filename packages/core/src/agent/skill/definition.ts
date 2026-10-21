/** Environment-neutral skill definitions and provider contracts. */

import { deepFreeze } from '../../primitives/index.ts'

export const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_INSTRUCTIONS_CHARS = 40_000
export const MAX_SKILL_RESOURCE_CHARS = 40_000
export const MAX_SKILL_ID_CHARS = 128
export const MAX_SKILL_NAME_CHARS = 256
export const MAX_SKILL_DESCRIPTION_CHARS = 2_048
export const MAX_SKILL_WHEN_TO_USE_CHARS = 2_048
export const MAX_SKILL_RESOURCE_PATH_CHARS = 512
export const MAX_SKILL_CANDIDATES = 1_024
export const MAX_SKILL_DIAGNOSTIC_ID_CHARS = 128
export const SKILL_CANDIDATE_LIMITS = Object.freeze({
  idChars: MAX_SKILL_ID_CHARS,
  nameChars: MAX_SKILL_NAME_CHARS,
  descriptionChars: MAX_SKILL_DESCRIPTION_CHARS,
  whenToUseChars: MAX_SKILL_WHEN_TO_USE_CHARS,
  instructionsChars: MAX_SKILL_INSTRUCTIONS_CHARS,
  sourceChars: MAX_SKILL_NAME_CHARS,
  providerChars: MAX_SKILL_NAME_CHARS,
  maxCandidates: MAX_SKILL_CANDIDATES,
})

export const SKILL_CANDIDATE_DIAGNOSTIC_CODE = 'SKILL_CANDIDATE_REJECTED'
export type SkillCandidateRejectionReason =
  | 'candidate-invalid'
  | 'id-invalid'
  | 'name-invalid'
  | 'description-invalid'
  | 'trigger-invalid'
  | 'instructions-invalid'
  | 'invocation-invalid'
  | 'provider-mismatch'
  | 'locator-invalid'
  | 'duplicate-id'
  | 'candidate-limit'
  | 'catalog-byte-limit'

/** A candidate validation failure with a stable, machine-readable reason. */
export class SkillCandidateValidationError extends TypeError {
  constructor(readonly reason: SkillCandidateRejectionReason, message: string) {
    super(message)
    this.name = 'SkillCandidateValidationError'
  }
}

export interface SkillCatalogDiagnostic {
  readonly type: 'skill-candidate-rejected'
  readonly code: typeof SKILL_CANDIDATE_DIAGNOSTIC_CODE
  readonly providerId: string
  readonly candidateId?: string
  readonly reason: SkillCandidateRejectionReason
}

export interface SkillInvocationPolicy {
  /** Whether the model may discover and load this skill. Defaults to true. */
  readonly modelInvocable: boolean
  /** Whether a host UI may offer this skill for explicit invocation. Defaults to true. */
  readonly userInvocable: boolean
}

export interface SkillResourceBase {
  readonly kind: 'directory' | 'url' | 'opaque'
  readonly value: string
}

/** Metadata only. Resource contents stay behind SkillProvider.readResource(). */
export interface SkillResourceSummary {
  readonly path: string
  readonly sizeBytes?: number
  readonly sizeChars?: number
}

export interface SkillDefinitionInput {
  /** Kebab-case stable identity used by model tools and host UIs. */
  readonly id: string
  /** Human-readable title; defaults to id. */
  readonly name?: string
  /** Short routing signal shown before the body is loaded. */
  readonly description: string
  /** Optional extra selection boundary. */
  readonly whenToUse?: string
  /** Instructions loaded only after this skill is selected. */
  readonly instructions: string
  /** Addressable text resources. Keys are skill-relative POSIX paths. */
  readonly resources?: Readonly<Record<string, string>>
  /** Lazy resources advertised without embedding their contents. */
  readonly resourceManifest?: readonly SkillResourceSummary[]
  readonly invocation?: Partial<SkillInvocationPolicy>
  /** Origin label useful to catalogs and UIs. Defaults to runtime. */
  readonly source?: string
  /** Provider label useful to diagnostics. Defaults to inline. */
  readonly provider?: string
  readonly resourceBase?: SkillResourceBase
  /** Absolute or provider-native location when one exists. */
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillDefinition {
  readonly kind: 'skill'
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly instructions: string
  readonly resources: Readonly<Record<string, string>>
  readonly resourceManifest: readonly SkillResourceSummary[]
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Lightweight discovery row. Skill instructions deliberately do not live here. */
export type SkillSummary = Omit<
  SkillDefinition,
  'kind' | 'instructions' | 'resources' | 'resourceManifest' | 'path' | 'metadata'
>

export interface SkillCandidate extends SkillSummary {
  /** Opaque provider-owned handle returned unchanged to load(). */
  readonly locator?: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SkillLookupOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
}

/** Discovery hints supplied by a scoped catalog to lazy providers. */
export interface SkillProviderListOptions extends SkillLookupOptions {
  /** Definition-owned allowlist. Providers may use it to avoid unrelated metadata I/O. */
  readonly allowedSkillIds?: readonly string[]
}

export interface SkillProvider {
  readonly kind: 'skill-provider'
  readonly id: string
  /** Discover metadata without loading instruction bodies or resources. */
  list(options: SkillProviderListOptions): Promise<readonly SkillCandidate[]>
  /** Load the complete body for a candidate previously returned by list(). */
  load(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinitionInput | undefined>
  /** Read one advertised resource. Providers should not preload these in load(). */
  readResource?(
    candidate: SkillCandidate,
    path: string,
    options: SkillLookupOptions,
  ): Promise<string | undefined>
}

export type SkillSource = SkillDefinition | SkillProvider

/** Define an immutable in-memory skill. This path is safe in browsers and edge runtimes. */
export function defineSkill(input: SkillDefinitionInput): SkillDefinition {
  validateSkillInput(input)
  const resources = Object.fromEntries(Object.entries(input.resources ?? {}).map(([path, content]) => {
    validateResource(path, content, input.id)
    return [path, content]
  }))
  const manifest = new Map<string, SkillResourceSummary>()
  for (const resource of input.resourceManifest ?? []) {
    validateResourceSummary(resource, input.id)
    if (manifest.has(resource.path)) {
      throw new TypeError(`skill '${input.id}' has duplicate resource '${resource.path}'`)
    }
    manifest.set(resource.path, Object.freeze({ ...resource }))
  }
  for (const [path, content] of Object.entries(resources)) {
    manifest.set(path, Object.freeze({ path, sizeChars: content.length }))
  }
  return deepFreeze({
    kind: 'skill' as const,
    id: input.id,
    name: input.name ?? input.id,
    description: input.description,
    ...(input.whenToUse === undefined ? {} : { whenToUse: input.whenToUse }),
    instructions: input.instructions,
    resources,
    resourceManifest: [...manifest.values()].sort((left, right) => left.path.localeCompare(right.path)),
    invocation: skillInvocation(input),
    source: input.source ?? 'runtime',
    provider: input.provider ?? 'inline',
    ...skillLocation(input),
  })
}

/** Typed pass-through for custom browser, remote, database, or filesystem providers. */
export function defineSkillProvider(provider: SkillProvider): SkillProvider {
  validateProvider(provider)
  return provider
}

export function skillSummary(skill: SkillDefinition): SkillSummary {
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    source: skill.source,
    provider: skill.provider,
    ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
  })
}

export function validateSkillSource(source: SkillSource): void {
  if (source.kind === 'skill') {
    validateSkillInput(source)
    for (const [path, content] of Object.entries(source.resources)) {
      validateResource(path, content, source.id)
    }
    for (const resource of source.resourceManifest) validateResourceSummary(resource, source.id)
    return
  }
  validateProvider(source)
}

/** Validate one public skill identity without constructing a definition. */
export function validateSkillId(id: string, label = 'skill'): void {
  validateIdentity(id, label)
}

export function validateCandidate(candidate: SkillCandidate, providerId: string): void {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new SkillCandidateValidationError('candidate-invalid', 'skill candidate must be an object')
  }
  validateCandidateField('id-invalid', () => validateIdentity(candidate.id, `skill from provider '${providerId}'`))
  validateCandidateField('name-invalid', () =>
    boundedNonEmpty(candidate.name, `skill '${candidate.id}' name`, MAX_SKILL_NAME_CHARS))
  validateCandidateField('description-invalid', () =>
    boundedNonEmpty(candidate.description, `skill '${candidate.id}' description`, MAX_SKILL_DESCRIPTION_CHARS))
  if (candidate.whenToUse !== undefined) {
    validateCandidateField('trigger-invalid', () =>
      boundedNonEmpty(candidate.whenToUse, `skill '${candidate.id}' whenToUse`, MAX_SKILL_WHEN_TO_USE_CHARS))
  }
  validateCandidateField('candidate-invalid', () =>
    boundedNonEmpty(candidate.source, `skill '${candidate.id}' source`, MAX_SKILL_NAME_CHARS))
  validateCandidateField('candidate-invalid', () =>
    boundedNonEmpty(candidate.provider, `skill '${candidate.id}' provider`, MAX_SKILL_NAME_CHARS))
  if (candidate.provider !== providerId) {
    throw new SkillCandidateValidationError('provider-mismatch',
      `skill '${candidate.id}' declares provider '${candidate.provider}', expected '${providerId}'`,
    )
  }
  validateCandidateField('invocation-invalid', () =>
    validateInvocation(candidate.invocation, `skill '${candidate.id}'`))
}

function validateCandidateField(reason: SkillCandidateRejectionReason, validate: () => void): void {
  try { validate() }
  catch (error: unknown) {
    if (error instanceof SkillCandidateValidationError) throw error
    const message = error instanceof Error ? error.message : 'invalid skill candidate'
    throw new SkillCandidateValidationError(reason, message)
  }
}

function validateSkillInput(input: SkillDefinitionInput): void {
  validateIdentity(input.id, 'skill')
  if (input.name !== undefined) boundedNonEmpty(input.name, `skill '${input.id}' name`, MAX_SKILL_NAME_CHARS)
  boundedNonEmpty(input.description, `skill '${input.id}' description`, MAX_SKILL_DESCRIPTION_CHARS)
  if (input.whenToUse !== undefined) {
    boundedNonEmpty(input.whenToUse, `skill '${input.id}' whenToUse`, MAX_SKILL_WHEN_TO_USE_CHARS)
  }
  nonEmpty(input.instructions, `skill '${input.id}' instructions`)
  if (input.instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
    throw new RangeError(`skill '${input.id}' instructions exceed ${MAX_SKILL_INSTRUCTIONS_CHARS} characters`)
  }
  validateOptionalInvocation(input)
  if (input.source !== undefined) nonEmpty(input.source, `skill '${input.id}' source`)
  if (input.provider !== undefined) nonEmpty(input.provider, `skill '${input.id}' provider`)
  if (input.path !== undefined) nonEmpty(input.path, `skill '${input.id}' path`)
  if (input.resourceBase !== undefined) {
    nonEmpty(input.resourceBase.value, `skill '${input.id}' resourceBase.value`)
  }
}

function validateProvider(provider: SkillProvider): void {
  if (provider.kind !== 'skill-provider') throw new TypeError('skill provider kind must be skill-provider')
  nonEmpty(provider.id, 'skill provider id')
  if (typeof provider.list !== 'function') throw new TypeError(`skill provider '${provider.id}' must implement list()`)
  if (typeof provider.load !== 'function') throw new TypeError(`skill provider '${provider.id}' must implement load()`)
  if (provider.readResource !== undefined && typeof provider.readResource !== 'function') {
    throw new TypeError(`skill provider '${provider.id}' readResource must be a function`)
  }
}

function validateIdentity(id: string, label: string): void {
  if (typeof id !== 'string' || id.length > MAX_SKILL_ID_CHARS || !SKILL_ID_PATTERN.test(id)) {
    throw new TypeError(`${label} id must be kebab-case`)
  }
}

function validateInvocation(value: SkillInvocationPolicy, label: string): void {
  if (typeof value?.modelInvocable !== 'boolean' || typeof value.userInvocable !== 'boolean') {
    throw new TypeError(`${label} must declare boolean invocation policy`)
  }
}

function validateResource(path: string, content: string, skillId: string): void {
  validateSkillResourcePath(path, skillId)
  if (typeof content !== 'string') throw new TypeError(`skill '${skillId}' resource '${path}' must be text`)
  if (content.length > MAX_SKILL_RESOURCE_CHARS) {
    throw new RangeError(`skill '${skillId}' resource '${path}' exceeds ${MAX_SKILL_RESOURCE_CHARS} characters`)
  }
}

export function validateSkillResourcePath(path: string, skillId: string): void {
  if (path.length > MAX_SKILL_RESOURCE_PATH_CHARS || /[\u0000-\u001f\u007f]/.test(path)
    || !isRelativeResourcePath(path)) {
    throw new TypeError(`skill '${skillId}' resource '${path}' must be a normalized relative path`)
  }
}

function validateResourceSummary(resource: SkillResourceSummary, skillId: string): void {
  validateSkillResourcePath(resource.path, skillId)
  optionalSize(resource.sizeBytes, `skill '${skillId}' resource '${resource.path}' sizeBytes`)
  optionalSize(resource.sizeChars, `skill '${skillId}' resource '${resource.path}' sizeChars`)
}

function optionalSize(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
}

function isRelativeResourcePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.startsWith('\\')) return false
  const normalized = path.replace(/\\/g, '/')
  if (normalized !== path || /^[a-zA-Z]:/.test(path)) return false
  return normalized.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function boundedNonEmpty(value: unknown, label: string, max: number): asserts value is string {
  nonEmpty(value, label)
  if (value.length > max) throw new RangeError(`${label} exceeds ${max} characters`)
}

function skillInvocation(input: SkillDefinitionInput): SkillInvocationPolicy {
  return {
    modelInvocable: input.invocation?.modelInvocable ?? true,
    userInvocable: input.invocation?.userInvocable ?? true,
  }
}

function skillLocation(input: SkillDefinitionInput) {
  return {
    ...(input.resourceBase === undefined ? {} : { resourceBase: input.resourceBase }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
  }
}

function validateOptionalInvocation(input: SkillDefinitionInput): void {
  if (input.invocation !== undefined) {
    for (const [field, value] of Object.entries(input.invocation)) {
      if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError(`skill '${input.id}' invocation.${field} must be boolean`)
      }
    }
  }
}
