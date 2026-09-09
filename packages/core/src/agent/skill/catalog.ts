/** Merged, refreshable skill catalog shared by web and filesystem sources. */

import {
  MAX_SKILL_RESOURCE_CHARS,
  defineSkill,
  skillSummary,
  validateCandidate,
  validateSkillId,
  validateSkillResourcePath,
  validateSkillSource,
  type SkillCandidate,
  type SkillDefinition,
  type SkillDefinitionInput,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderListOptions,
  type SkillResourceSummary,
  type SkillSummary,
} from './definition.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { captureSkillProviderPlugin } from './provider/definition.ts'
import { skillProviderLogger } from './provider/context.ts'
import { capabilityIdentityError } from '../../errors/capability-identity.ts'
import { SKILL_ERROR_CODES, SKILL_PROVIDER_API_VERSION } from './provider/config.ts'
import {
  captureSkillCatalogSnapshot, captureSkillReference,
} from './provider/snapshot.ts'
import type {
  ActivatedSkillSnapshot, CapturedSkillProviderPlugin, RuntimeSkillCandidate,
  RuntimeSkillLookupOptions, RuntimeSkillSource, SkillReference,
} from './provider/types.ts'

interface CatalogEntry {
  readonly summary: SkillSummary
  readonly direct?: SkillDefinition
  readonly provider?: SkillProvider
  readonly candidate?: SkillCandidate
  readonly runtimeProvider?: CapturedSkillProviderPlugin
  readonly reference?: SkillReference
}

export interface SkillCatalogOptions {
  /** When present, only these skill ids are visible or loadable. */
  readonly allowedSkillIds?: readonly string[]
  readonly maxSkills?: number
  readonly maxCatalogBytes?: number
}

export class SkillCatalog {
  private readonly sources: readonly RuntimeSkillSource[]
  private readonly allowedSkillIds: readonly string[] | undefined
  private readonly allowedSkillIdSet: ReadonlySet<string> | undefined
  private readonly maxSkills: number
  private readonly maxCatalogBytes: number
  private entries = new Map<string, CatalogEntry>()
  private visible: readonly SkillSummary[] = Object.freeze([])
  private readonly activated = new Map<string, readonly SkillResourceSummary[]>()
  private readonly activatedReferences = new Map<string, ActivatedSkillSnapshot>()
  private discoveryTail: Promise<void> = Promise.resolve()
  private discovered = false

  constructor(sources: readonly RuntimeSkillSource[], options: SkillCatalogOptions = {}) {
    this.maxSkills = positiveSafeInteger(options.maxSkills ?? 1_024, 'skill catalog maxSkills')
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'skill catalog maxCatalogBytes')
    this.sources = captureCatalogSources(sources)
    if (options.allowedSkillIds === undefined) {
      this.allowedSkillIds = undefined
      this.allowedSkillIdSet = undefined
    } else {
      const ids = [...options.allowedSkillIds]
      const seen = new Set<string>()
      for (const id of ids) {
        validateSkillId(id, 'allowed skill')
        if (seen.has(id)) throw new TypeError(`duplicate allowed skill '${id}'`)
        seen.add(id)
      }
      this.allowedSkillIds = Object.freeze(ids)
      this.allowedSkillIdSet = seen
    }
    this.installDirectSkills()
  }

  /** Refresh provider metadata. Direct definitions remain available without I/O. */
  async discover(options: SkillLookupOptions = {}): Promise<readonly SkillSummary[]> {
    const previous = this.discoveryTail
    const run = raceAbort(previous, options.signal)
      .then(() => this.performDiscovery(options))
    // An aborted waiter must not detach the queue from a discovery still in
    // progress, otherwise the next caller could overlap the original provider I/O.
    this.discoveryTail = Promise.allSettled([previous, run]).then(() => undefined)
    return await run
  }

  private async performDiscovery(options: SkillLookupOptions): Promise<readonly SkillSummary[]> {
    throwIfAborted(options.signal)
    const next = new Map<string, CatalogEntry>()
    let catalogBytes = 0
    if (this.allowedSkillIds?.length === 0) {
      this.activated.clear()
      this.entries = next
      this.visible = Object.freeze([])
      this.discovered = true
      return this.visible
    }
    for (const source of this.sources) {
      if (source.kind === 'skill') {
        if (!this.isAllowed(source.id)) continue
        catalogBytes = addCatalogBytes(catalogBytes, source, this.maxCatalogBytes)
        if (next.size >= this.maxSkills) throw new RangeError(`skill catalog exceeds ${this.maxSkills} entries`)
        addUnique(next, source.id, { summary: skillSummary(source), direct: source })
        continue
      }
      if (isRuntimeProvider(source)) {
        const raw = await raceAbort(source.list(this.runtimeProviderListOptions(options)), options.signal)
        throwIfAborted(options.signal)
        const snapshot = captureSkillCatalogSnapshot(source, raw, this.maxSkills, this.maxCatalogBytes)
        for (let index = 0; index < snapshot.candidates.length; index++) {
          const candidate = snapshot.candidates[index]!
          if (!this.isAllowed(candidate.id)) continue
          catalogBytes = addCatalogBytes(catalogBytes, candidate, this.maxCatalogBytes)
          if (next.size >= this.maxSkills) throw new RangeError(`skill catalog exceeds ${this.maxSkills} entries`)
          addUnique(next, candidate.id, { summary: summaryOfRuntimeCandidate(candidate),
            runtimeProvider: source, reference: snapshot.references[index]! })
        }
        continue
      }
      const candidates = await raceAbort(source.list(this.providerListOptions(options)), options.signal)
      throwIfAborted(options.signal)
      if (candidates.length > this.maxSkills) {
        throw new RangeError(`skill provider '${source.id}' exceeds the ${this.maxSkills}-candidate limit`)
      }
      for (const candidate of candidates) {
        validateCandidate(candidate, source.id)
        if (!this.isAllowed(candidate.id)) continue
        catalogBytes = addCatalogBytes(catalogBytes, candidate, this.maxCatalogBytes)
        if (next.size >= this.maxSkills) throw new RangeError(`skill catalog exceeds ${this.maxSkills} entries`)
        addUnique(next, candidate.id, {
          summary: summaryOfCandidate(candidate), provider: source, candidate,
        })
      }
    }
    this.assertAllowedSkillsAvailable(next)
    for (const id of this.activated.keys()) {
      const previous = this.entries.get(id)
      const current = next.get(id)
      if (previous === undefined || current === undefined
        || !sameCatalogEntry(previous, current)) {
        this.activated.delete(id)
        this.activatedReferences.delete(id)
      }
    }
    this.entries = next
    this.visible = freezeSummaries(next)
    this.discovered = true
    return this.visible
  }

  /** Last successfully discovered catalog. Direct skills are present immediately. */
  summaries(): readonly SkillSummary[] { return this.visible }

  /** Load a complete body on demand. Provider definitions are intentionally not cached. */
  async load(id: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    throwIfAborted(options.signal)
    if (!this.discovered && (this.allowedSkillIds !== undefined
      || this.sources.some(source => source.kind === 'skill-provider'))) {
      await this.discover(options)
    }
    const entry = this.entries.get(id)
    if (entry?.direct !== undefined) return entry.direct
    if (entry?.runtimeProvider !== undefined && entry.reference !== undefined) {
      const input = await raceAbort(
        entry.runtimeProvider.load(entry.reference, this.runtimeLookupOptions(options)), options.signal,
      )
      throwIfAborted(options.signal)
      if (input === undefined) return undefined
      return this.resolveRuntimeSkill(input, entry)
    }
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

  /** Load one selected skill and remember only its small resource manifest. */
  async activate(id: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!this.discovered && (this.allowedSkillIds !== undefined
      || this.sources.some(source => source.kind === 'skill-provider'))) {
      await this.discover(options)
    }
    const selected = this.entries.get(id)
    const skill = await this.load(id, options)
    const current = this.entries.get(id)
    if (skill !== undefined && (selected === undefined || current === undefined
      || !sameCatalogEntry(selected, current))) {
      throw new Error(`skill '${id}' changed while its instructions were loading; load it again`)
    }
    if (skill !== undefined) {
      this.activated.set(id, skill.resourceManifest)
      if (current?.reference !== undefined) this.activatedReferences.set(id, Object.freeze({
        ...current.reference,
        ...(skill.resourceBase === undefined ? {} : { resourceBase: Object.freeze({ ...skill.resourceBase }) }),
      }))
    }
    return skill
  }

  isActivated(id: string): boolean { return this.activated.has(id) }

  activatedResources(id: string): readonly SkillResourceSummary[] | undefined {
    return this.activated.get(id)
  }

  /** Activated identities in deterministic catalog order, suitable for session persistence. */
  activatedSummaries(): readonly SkillSummary[] {
    return Object.freeze(this.visible.filter(summary => this.activated.has(summary.id)))
  }

  activatedSkillReferences(): readonly ActivatedSkillSnapshot[] {
    return Object.freeze([...this.activatedReferences.values()]
      .sort((left, right) => left.id.localeCompare(right.id)))
  }

  /** Forget conversation-scoped activation without rebuilding provider configuration. */
  clearActivations(): void { this.activated.clear(); this.activatedReferences.clear() }

  validateReferenceOwner(value: unknown): ActivatedSkillSnapshot {
    const reference = captureSkillReference(value)
    if (!this.sources.some(source => isRuntimeProvider(source) && source.id === reference.provider)) {
      throw new AgentSdkError('Persisted skill reference has no matching provider', SKILL_ERROR_CODES.REFERENCE_INVALID)
    }
    return reference
  }

  async restoreReference(value: unknown, options: SkillLookupOptions = {}): Promise<SkillDefinition> {
    throwIfAborted(options.signal)
    const reference = this.validateReferenceOwner(value)
    const provider = this.sources.find((source): source is CapturedSkillProviderPlugin =>
      isRuntimeProvider(source) && source.id === reference.provider)
    if (provider === undefined) throw referenceInvalid()
    const input = await raceAbort(
      provider.load(referenceOnly(reference), this.runtimeLookupOptions(options)), options.signal,
    )
    throwIfAborted(options.signal)
    if (input === undefined) throw referenceUnavailable()
    const entry: CatalogEntry = { summary: summaryFromReferenceInput(input, reference),
      runtimeProvider: provider, reference: referenceOnly(reference) }
    const skill = this.resolveRuntimeSkill(input, entry)
    if (reference.resourceBase?.kind !== skill.resourceBase?.kind
      || reference.resourceBase?.value !== skill.resourceBase?.value) throw referenceUnavailable()
    this.entries.set(reference.id, entry)
    this.visible = freezeSummaries(this.entries)
    this.activated.set(reference.id, skill.resourceManifest)
    this.activatedReferences.set(reference.id, reference)
    return skill
  }

  /** Read one advertised resource without hydrating the rest of the bundle. */
  async readResource(
    id: string,
    path: string,
    options: SkillLookupOptions = {},
  ): Promise<string | undefined> {
    throwIfAborted(options.signal)
    validateSkillResourcePath(path, id)
    if (!this.isActivated(id)) {
      throw new Error(`skill '${id}' must be activated before reading resources`)
    }
    const entry = this.entries.get(id)
    let skill = entry?.direct
    const lazyManifest = this.activated.get(id)
    if (skill === undefined && (lazyManifest === undefined || entry?.provider?.readResource === undefined)) {
      skill = await this.load(id, options)
    }
    if (skill !== undefined && skill.id !== id) {
      throw new TypeError(`loaded skill '${skill.id}' does not match '${id}'`)
    }
    const manifest = skill?.resourceManifest ?? lazyManifest
    if (manifest === undefined || !manifest.some(resource => resource.path === path)) return undefined
    const embedded = skill?.resources[path]
    if (embedded !== undefined) return embedded
    if (entry?.runtimeProvider !== undefined && entry.reference !== undefined) {
      if (entry.runtimeProvider.readResource === undefined) return undefined
      const content = await raceAbort(entry.runtimeProvider.readResource(
        entry.reference, path, this.runtimeLookupOptions(options),
      ), options.signal)
      return validateResourceContent(content, path)
    }
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

  private installDirectSkills(): void {
    const direct = new Map<string, CatalogEntry>()
    let catalogBytes = 0
    for (const source of this.sources) {
      if (source.kind === 'skill' && this.isAllowed(source.id)) {
        catalogBytes = addCatalogBytes(catalogBytes, source, this.maxCatalogBytes)
        if (direct.size >= this.maxSkills) throw new RangeError(`skill catalog exceeds ${this.maxSkills} entries`)
        addUnique(direct, source.id, { summary: skillSummary(source), direct: source })
      }
    }
    this.entries = direct
    this.visible = freezeSummaries(direct)
  }

  private isAllowed(id: string): boolean {
    return this.allowedSkillIdSet?.has(id) ?? true
  }

  private providerListOptions(options: SkillLookupOptions): SkillProviderListOptions {
    return this.allowedSkillIds === undefined
      ? options
      : { ...options, allowedSkillIds: this.allowedSkillIds }
  }

  private runtimeLookupOptions(options: SkillLookupOptions): RuntimeSkillLookupOptions {
    return Object.freeze({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      signal: options.signal ?? new AbortController().signal,
      logger: skillProviderLogger(this),
    })
  }

  private runtimeProviderListOptions(options: SkillLookupOptions): RuntimeSkillLookupOptions & {
    readonly allowedSkillIds?: readonly string[]
  } {
    return Object.freeze({ ...this.runtimeLookupOptions(options),
      ...(this.allowedSkillIds === undefined ? {} : { allowedSkillIds: this.allowedSkillIds }) })
  }

  private resolveRuntimeSkill(input: SkillDefinitionInput, entry: CatalogEntry): SkillDefinition {
    const reference = entry.reference
    if (reference === undefined) throw referenceInvalid()
    const resolved = defineSkill({ ...input, id: reference.id, source: reference.source,
      provider: reference.provider, invocation: entry.summary.invocation })
    if (input.id !== reference.id) throw referenceUnavailable()
    return resolved
  }

  private assertAllowedSkillsAvailable(entries: ReadonlyMap<string, CatalogEntry>): void {
    if (this.allowedSkillIds === undefined) return
    const missing = this.allowedSkillIds.filter(id => !entries.has(id))
    if (missing.length > 0) {
      throw new Error(`configured skill${missing.length === 1 ? '' : 's'} not available: ${missing.join(', ')}`)
    }
  }
}

function summaryOfCandidate(candidate: SkillCandidate): SkillSummary {
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

function summaryOfRuntimeCandidate(candidate: RuntimeSkillCandidate): SkillSummary {
  return Object.freeze({
    id: candidate.id, name: candidate.name, description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: candidate.invocation ?? Object.freeze({ modelInvocable: true, userInvocable: true }),
    source: candidate.source, provider: candidate.provider,
  })
}

function summaryFromReferenceInput(input: SkillDefinitionInput, reference: ActivatedSkillSnapshot): SkillSummary {
  return skillSummary(defineSkill({ ...input, id: reference.id, source: reference.source, provider: reference.provider }))
}

function captureCatalogSources(sources: readonly RuntimeSkillSource[]): readonly RuntimeSkillSource[] {
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

function isRuntimeProvider(source: RuntimeSkillSource): source is CapturedSkillProviderPlugin {
  return source.kind === 'skill-provider'
    && Object.getOwnPropertyDescriptor(source, 'apiVersion')?.value === SKILL_PROVIDER_API_VERSION
}

function referenceOnly(value: ActivatedSkillSnapshot): SkillReference {
  return Object.freeze({ id: value.id, source: value.source, provider: value.provider,
    catalogRevision: value.catalogRevision,
    ...(value.locator === undefined ? {} : { locator: value.locator }) })
}

function validateResourceContent(content: string | undefined, path: string): string | undefined {
  if (content === undefined) return undefined
  if (typeof content !== 'string') throw new TypeError(`skill provider returned a non-text resource '${path}'`)
  if (content.length > MAX_SKILL_RESOURCE_CHARS) {
    throw new RangeError(`skill resource '${path}' exceeds ${MAX_SKILL_RESOURCE_CHARS} characters`)
  }
  return content
}

function referenceInvalid(): AgentSdkError {
  return new AgentSdkError('Persisted skill reference is invalid', SKILL_ERROR_CODES.REFERENCE_INVALID)
}

function referenceUnavailable(): AgentSdkError {
  return new AgentSdkError('Persisted skill reference is unavailable', SKILL_ERROR_CODES.REFERENCE_UNAVAILABLE)
}

function addUnique(
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

function freezeSummaries(entries: ReadonlyMap<string, CatalogEntry>): readonly SkillSummary[] {
  return Object.freeze([...entries.values()].map(entry => entry.summary)
    .sort((left, right) => left.id.localeCompare(right.id)))
}

/**
 * Preserve activation only when shallow discovery describes the same definition.
 * Providers can put an etag/version in locator or metadata to invalidate an
 * activated body without making discovery hydrate that body again.
 */
function sameCatalogEntry(previous: CatalogEntry, current: CatalogEntry): boolean {
  if (previous.direct !== undefined || current.direct !== undefined) {
    return previous.direct === current.direct
  }
  if (previous.provider !== current.provider) return false
  if (previous.runtimeProvider !== undefined || current.runtimeProvider !== undefined) {
    return previous.runtimeProvider === current.runtimeProvider
      && previous.reference?.id === current.reference?.id
      && previous.reference?.source === current.reference?.source
      && previous.reference?.provider === current.reference?.provider
      && previous.reference?.catalogRevision === current.reference?.catalogRevision
      && sameRevisionValue(previous.reference?.locator, current.reference?.locator)
  }
  if (!sameSummary(previous.summary, current.summary)) return false
  const left = previous.candidate
  const right = current.candidate
  if (left === undefined || right === undefined) return left === right
  return left.path === right.path
    && sameRevisionValue(left.locator, right.locator)
    && sameRevisionValue(left.metadata, right.metadata)
}

function sameSummary(left: SkillSummary, right: SkillSummary): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.description === right.description
    && left.whenToUse === right.whenToUse
    && left.source === right.source
    && left.provider === right.provider
    && left.invocation.modelInvocable === right.invocation.modelInvocable
    && left.invocation.userInvocable === right.invocation.userInvocable
    && left.resourceBase?.kind === right.resourceBase?.kind
    && left.resourceBase?.value === right.resourceBase?.value
}

/** Bounded structural equality for provider-owned JSON-like revision handles. */
function sameRevisionValue(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]]
  const seen = new WeakMap<object, WeakSet<object>>()
  let visited = 0
  try {
    while (pending.length > 0) {
      const pair = pending.pop()
      if (pair === undefined) break
      const [a, b] = pair
      if (Object.is(a, b)) continue
      if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
      if (++visited > 2_048) return false
      let matches = seen.get(a)
      if (matches?.has(b) === true) continue
      if (matches === undefined) { matches = new WeakSet<object>(); seen.set(a, matches) }
      matches.add(b)
      if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        for (let index = 0; index < a.length; index++) pending.push([a[index], b[index]])
        continue
      }
      const aPrototype = Object.getPrototypeOf(a) as unknown
      const bPrototype = Object.getPrototypeOf(b) as unknown
      if (aPrototype !== bPrototype
        || (aPrototype !== Object.prototype && aPrototype !== null)) return false
      const aRecord = a as Record<string, unknown>
      const bRecord = b as Record<string, unknown>
      const aKeys = Object.keys(aRecord).sort()
      const bKeys = Object.keys(bRecord).sort()
      if (aKeys.length !== bKeys.length
        || aKeys.some((key, index) => key !== bKeys[index])) return false
      for (const key of aKeys) pending.push([aRecord[key], bRecord[key]])
    }
    return true
  } catch {
    // A getter/proxy or exotic provider handle is not a stable revision signal.
    return false
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error('skill discovery aborted')
}

function addCatalogBytes(total: number, value: unknown, maxBytes: number): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('skill catalog entry is not JSON serializable')
  const next = total + new TextEncoder().encode(serialized).byteLength
  if (next > maxBytes) throw new RangeError(`skill catalog exceeds ${maxBytes} serialized bytes`)
  return next
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive safe integer`)
  return value
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
