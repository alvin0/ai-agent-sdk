import { AgentSdkError } from '../../../errors/agent-sdk-error.ts'
import { capabilityIdentityError } from '../../../errors/capability-identity.ts'
import { snapshotJsonValue } from '../../../primitives/json-snapshot.ts'
import type { JsonValue } from '../../../primitives/index.ts'
import { boundedText, objectValue, ownData } from '../../../capability/common/data.ts'
import {
  MAX_SKILL_CANDIDATES, MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_INSTRUCTIONS_CHARS,
  MAX_SKILL_NAME_CHARS, validateSkillId,
  MAX_SKILL_WHEN_TO_USE_CHARS, type SkillCandidateRejectionReason, type SkillResourceBase,
} from '../definition.ts'
import { SKILL_ERROR_CODES, SKILL_PROVIDER_LIMITS } from './config.ts'
import type {
  ActivatedSkillSnapshot, CapturedSkillProviderPlugin, RuntimeSkillCandidate,
  SkillReference,
} from './types.ts'
import { emitSkillCandidateDiagnostic, type SkillDiagnosticObserver } from '../catalog-diagnostics.ts'

const CANDIDATE_KEYS = new Set([
  'id', 'name', 'description', 'whenToUse', 'invocation', 'source', 'provider', 'locator',
])
const REFERENCE_KEYS = new Set(['id', 'source', 'provider', 'catalogRevision', 'locator', 'resourceBase'])

export interface CapturedSkillCatalogSnapshot {
  readonly revision: string
  readonly candidates: readonly RuntimeSkillCandidate[]
  readonly references: readonly SkillReference[]
}

export interface SkillCatalogCaptureOptions {
  readonly maxSkills: number
  readonly maxBytes: number
  readonly onDiagnostic?: SkillDiagnosticObserver
  readonly strictCandidates?: boolean
}

export function captureSkillCatalogSnapshot(
  provider: CapturedSkillProviderPlugin,
  value: unknown,
  options: SkillCatalogCaptureOptions,
): CapturedSkillCatalogSnapshot {
  try {
    const envelope = captureCatalogEnvelope(value)
    const collector = new CandidateSnapshotCollector(provider, envelope.revision, options)
    const boundedLength = Math.min(envelope.length, MAX_SKILL_CANDIDATES)
    for (let index = 0; index < boundedLength; index++) {
      let entry: unknown
      try { entry = ownData(envelope.candidates, String(index)) }
      catch { collector.reject(undefined, 'candidate-invalid'); continue }
      collector.add(index, entry)
    }
    if (envelope.length > MAX_SKILL_CANDIDATES) {
      collector.addOverflow(envelope.candidates)
    }
    return collector.snapshot()
  } catch (error) {
    if (error instanceof AgentSdkError) throw error
    throw invalidCatalog()
  }
}

function captureCatalogEnvelope(value: unknown): {
  readonly revision: string
  readonly candidates: unknown[]
  readonly length: number
} {
  const source = objectValue(value)
  exactKeys(source, new Set(['revision', 'candidates']))
  const revision = boundedText(ownData(source, 'revision'), SKILL_PROVIDER_LIMITS.revisionBytes)
  const candidates = ownData(source, 'candidates')
  if (!Array.isArray(candidates)) throw invalidCatalog()
  const length = ownData(candidates, 'length')
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw invalidCatalog()
  return { revision, candidates, length }
}

class CandidateSnapshotCollector {
  private readonly candidates: RuntimeSkillCandidate[] = []
  private readonly references: SkillReference[] = []
  private readonly ids = new Map<string, number>()
  private readonly strict: boolean
  private readonly onDiagnostic: SkillDiagnosticObserver | undefined
  private bytes: number

  constructor(
    private readonly provider: CapturedSkillProviderPlugin,
    private readonly revision: string,
    private readonly options: SkillCatalogCaptureOptions,
  ) {
    this.strict = options.strictCandidates ?? false
    this.onDiagnostic = options.onDiagnostic
    this.bytes = new TextEncoder().encode(JSON.stringify({ revision, candidates: [], references: [] })).byteLength
  }

  add(index: number, raw: unknown): void {
    const candidate = this.capture(raw)
    if (candidate === undefined || !this.available(raw)) return
    if (!this.unique(index, raw, candidate)) return
    this.store(raw, index, candidate)
  }

  addOverflow(candidates: unknown[]): void {
    let raw: unknown
    try { raw = ownData(candidates, String(MAX_SKILL_CANDIDATES)) } catch { /* diagnostic ID is optional */ }
    this.reject(raw, 'candidate-limit')
  }

  reject(raw: unknown, reason: SkillCandidateRejectionReason): void {
    emitSkillCandidateDiagnostic(this.onDiagnostic, this.provider.id, raw, reason)
    if (this.strict) throw invalidCatalog()
  }

  snapshot(): CapturedSkillCatalogSnapshot {
    return Object.freeze({ revision: this.revision, candidates: Object.freeze(this.candidates),
      references: Object.freeze(this.references) })
  }

  private capture(raw: unknown): RuntimeSkillCandidate | undefined {
    try { return captureCandidate(raw, this.provider.id) }
    catch (error: unknown) {
      this.reject(raw, error instanceof InvalidCandidate ? error.reason : 'candidate-invalid')
      return undefined
    }
  }

  private available(raw: unknown): boolean {
    if (this.candidates.length < this.options.maxSkills) return true
    this.reject(raw, 'candidate-limit')
    return false
  }

  private unique(index: number, raw: unknown, candidate: RuntimeSkillCandidate): boolean {
    const first = this.ids.get(candidate.id)
    if (first === undefined) return true
    emitSkillCandidateDiagnostic(this.onDiagnostic, this.provider.id, raw, 'duplicate-id')
    if (this.strict) throw capabilityIdentityError(SKILL_ERROR_CODES.ID_CONFLICT, 'skill-id', first, index)
    return false
  }

  private store(raw: unknown, index: number, candidate: RuntimeSkillCandidate): void {
    const reference = referenceFromCandidate(candidate, this.revision)
    const addedBytes = captureBytes(candidate, reference, this.candidates.length > 0)
    if (this.bytes + addedBytes > this.options.maxBytes) {
      this.reject(raw, 'catalog-byte-limit')
      return
    }
    this.bytes += addedBytes
    this.ids.set(candidate.id, index)
    this.candidates.push(candidate)
    this.references.push(reference)
  }
}

function captureBytes(candidate: RuntimeSkillCandidate, reference: SkillReference, hasPrior: boolean): number {
  const encoder = new TextEncoder()
  const candidateBytes = encoder.encode(JSON.stringify(candidate)).byteLength
  const referenceBytes = encoder.encode(JSON.stringify(reference)).byteLength
  return candidateBytes + referenceBytes + (hasPrior ? 2 : 0)
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
  const source = captureCandidateObject(value)
  const id = captureCandidateId(source)
  const provider = captureCandidateProvider(source, providerId)
  const name = candidateFieldText(source, 'name', MAX_SKILL_NAME_CHARS, { reason: 'name-invalid' })!
  const description = candidateFieldText(source, 'description', MAX_SKILL_DESCRIPTION_CHARS,
    { reason: 'description-invalid' })!
  const whenToUse = candidateFieldText(source, 'whenToUse', MAX_SKILL_WHEN_TO_USE_CHARS,
    { reason: 'trigger-invalid', optional: true })
  const invocation = captureCandidateInvocation(source)
  const locator = captureCandidateLocator(source)
  const sourceLabel = candidateFieldText(source, 'source', MAX_SKILL_NAME_CHARS,
    { reason: 'candidate-invalid' })!
  return Object.freeze({
    id, name, description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(invocation === undefined ? {} : { invocation }),
    source: sourceLabel, provider,
    ...locator,
  })
}

function captureCandidateObject(value: unknown): object {
  let source: object
  try { source = objectValue(value) } catch { throw new InvalidCandidate('candidate-invalid') }
  let instructions: unknown
  try { instructions = ownData(source, 'instructions', false) }
  catch { throw new InvalidCandidate('candidate-invalid') }
  if (instructions !== undefined) {
    if (typeof instructions !== 'string' || instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS) {
      throw new InvalidCandidate('instructions-invalid')
    }
    throw new InvalidCandidate('candidate-invalid')
  }
  try { exactKeys(source, CANDIDATE_KEYS) }
  catch { throw new InvalidCandidate('candidate-invalid') }
  return source
}

class InvalidCandidate extends Error {
  constructor(readonly reason: SkillCandidateRejectionReason) { super(reason) }
}

function captureCandidateId(source: object): string {
  try {
    const id = text(ownData(source, 'id'), MAX_SKILL_NAME_CHARS)
    validateSkillId(id)
    return id
  } catch { throw new InvalidCandidate('id-invalid') }
}

function captureCandidateProvider(source: object, providerId: string): string {
  let provider: string
  try { provider = text(ownData(source, 'provider'), SKILL_PROVIDER_LIMITS.identityBytes) }
  catch { throw new InvalidCandidate('provider-mismatch') }
  if (provider !== providerId) throw new InvalidCandidate('provider-mismatch')
  return provider
}

function candidateFieldText(
  source: object,
  key: string,
  max: number,
  field: { readonly reason: SkillCandidateRejectionReason; readonly optional?: boolean },
): string | undefined {
  try {
    const value = ownData(source, key, field.optional !== true)
    return value === undefined && field.optional === true ? undefined : candidateText(value, max)
  } catch { throw new InvalidCandidate(field.reason) }
}

function captureCandidateInvocation(source: object): RuntimeSkillCandidate['invocation'] {
  try { return captureInvocation(ownData(source, 'invocation', false)) }
  catch { throw new InvalidCandidate('invocation-invalid') }
}

function captureCandidateLocator(source: object): { readonly locator?: JsonValue } {
  try { return captureOptionalLocator(source) }
  catch { throw new InvalidCandidate('locator-invalid') }
}

function candidateText(value: unknown, max: number): string {
  if (!candidateTextOk(value, max)) throw new TypeError('invalid skill candidate text')
  return value as string
}

function candidateTextOk(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
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
