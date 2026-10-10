/** Merged, refreshable skill catalog shared by web and filesystem sources. */

import {
  defineSkill,
  skillSummary,
  validateSkillId,
  validateSkillResourcePath,
  type SkillDefinition,
  type SkillDefinitionInput,
  type SkillLookupOptions,
  type SkillProviderListOptions,
  type SkillResourceSummary,
  type SkillSummary,
} from './definition.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { skillProviderLogger } from './provider/context.ts'
import { SKILL_ERROR_CODES } from './provider/config.ts'
import {
  captureSkillReference,
} from './provider/snapshot.ts'
import type {
  ActivatedSkillSnapshot, CapturedSkillProviderPlugin,
  RuntimeSkillLookupOptions, RuntimeSkillSource,
} from './provider/types.ts'

import {
  addCatalogBytes, addUnique, captureCatalogSources, freezeSummaries, isRuntimeProvider,
  positiveSafeInteger, raceAbort, referenceInvalid, referenceOnly, referenceUnavailable,
  summaryFromReferenceInput, throwIfAborted, validateResourceContent, type CatalogEntry,
  loadLegacyEntry, needsResourceHydration, readLegacyResource,
} from './catalog-entries.ts'
import { sameCatalogEntry } from './catalog-equality.ts'
import { collectCatalogEntries } from './catalog-discovery.ts'

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
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024,
      'skill catalog maxCatalogBytes')
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
    if (this.allowedSkillIds?.length === 0) {
      this.activated.clear()
      this.entries = next
      this.visible = Object.freeze([])
      this.discovered = true
      return this.visible
    }
    await collectCatalogEntries(this.sources, {
      entries: next,
      maxSkills: this.maxSkills,
      maxCatalogBytes: this.maxCatalogBytes,
      isAllowed: id => this.isAllowed(id),
      legacyOptions: this.providerListOptions(options),
      runtimeOptions: this.runtimeProviderListOptions(options),
    }, options.signal)
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
    await this.ensureDiscovered(options)
    const entry = this.entries.get(id)
    if (entry?.direct !== undefined) return entry.direct
    if (entry?.runtimeProvider !== undefined && entry.reference !== undefined) {
      return this.loadRuntimeEntry(entry, options)
    }
    return loadLegacyEntry(id, entry, options)
  }

  private async ensureDiscovered(options: SkillLookupOptions): Promise<void> {
    if (!this.discovered && (this.allowedSkillIds !== undefined
      || this.sources.some(source => source.kind === 'skill-provider'))) {
      await this.discover(options)
    }
  }

  private async loadRuntimeEntry(
    entry: CatalogEntry, options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
    if (entry.runtimeProvider === undefined || entry.reference === undefined) return undefined
    const input = await raceAbort(
      entry.runtimeProvider.load(entry.reference, this.runtimeLookupOptions(options)), options.signal,
    )
    throwIfAborted(options.signal)
    if (input === undefined) return undefined
    return this.resolveRuntimeSkill(input, entry)
  }

  /** Load one selected skill and remember only its small resource manifest. */
  async activate(id: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    await this.ensureDiscovered(options)
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
    const { skill, manifest } = await this.resolveResourceSkill(id, entry, options)
    if (manifest === undefined || !manifest.some(resource => resource.path === path)) return undefined
    const embedded = skill?.resources[path]
    if (embedded !== undefined) return embedded
    if (entry?.runtimeProvider !== undefined && entry.reference !== undefined) {
      return this.readRuntimeResource(entry, path, options)
    }
    return readLegacyResource(entry, path, options)
  }

  private async resolveResourceSkill(
    id: string, entry: CatalogEntry | undefined, options: SkillLookupOptions,
  ): Promise<{ skill: SkillDefinition | undefined; manifest: readonly SkillResourceSummary[] | undefined }> {
    let skill = entry?.direct
    const lazyManifest = this.activated.get(id)
    if (skill === undefined && needsResourceHydration(entry, lazyManifest)) {
      skill = await this.load(id, options)
    }
    if (skill !== undefined && skill.id !== id) {
      throw new TypeError(`loaded skill '${skill.id}' does not match '${id}'`)
    }
    const manifest = skill?.resourceManifest ?? lazyManifest
    return { skill, manifest }
  }

  private async readRuntimeResource(
    entry: CatalogEntry, path: string, options: SkillLookupOptions,
  ): Promise<string | undefined> {
    if (entry.runtimeProvider?.readResource === undefined || entry.reference === undefined) return undefined
    const content = await raceAbort(entry.runtimeProvider.readResource(
      entry.reference, path, this.runtimeLookupOptions(options),
    ), options.signal)
    return validateResourceContent(content, path)
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

