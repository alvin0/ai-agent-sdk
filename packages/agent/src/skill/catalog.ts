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
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderListOptions,
  type SkillResourceSummary,
  type SkillSource,
  type SkillSummary,
} from './definition.ts'

interface CatalogEntry {
  readonly summary: SkillSummary
  readonly direct?: SkillDefinition
  readonly provider?: SkillProvider
  readonly candidate?: SkillCandidate
}

export interface SkillCatalogOptions {
  /** When present, only these skill ids are visible or loadable. */
  readonly allowedSkillIds?: readonly string[]
  readonly maxSkills?: number
  readonly maxCatalogBytes?: number
}

export class SkillCatalog {
  private readonly sources: readonly SkillSource[]
  private readonly allowedSkillIds: readonly string[] | undefined
  private readonly allowedSkillIdSet: ReadonlySet<string> | undefined
  private readonly maxSkills: number
  private readonly maxCatalogBytes: number
  private entries = new Map<string, CatalogEntry>()
  private visible: readonly SkillSummary[] = Object.freeze([])
  private readonly activated = new Map<string, readonly SkillResourceSummary[]>()
  private discoveryTail: Promise<void> = Promise.resolve()
  private discovered = false

  constructor(sources: readonly SkillSource[], options: SkillCatalogOptions = {}) {
    this.maxSkills = positiveSafeInteger(options.maxSkills ?? 1_024, 'skill catalog maxSkills')
    this.maxCatalogBytes = positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'skill catalog maxCatalogBytes')
    for (const source of sources) validateSkillSource(source)
    this.sources = Object.freeze([...sources])
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
        addUnique(next, source.id, { summary: skillSummary(source), direct: source }, 'inline')
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
        }, source.id)
      }
    }
    this.assertAllowedSkillsAvailable(next)
    for (const id of this.activated.keys()) {
      const previous = this.entries.get(id)
      const current = next.get(id)
      if (previous === undefined || current === undefined
        || !sameCatalogEntry(previous, current)) {
        this.activated.delete(id)
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
    if (skill !== undefined) this.activated.set(id, skill.resourceManifest)
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

  /** Forget conversation-scoped activation without rebuilding provider configuration. */
  clearActivations(): void { this.activated.clear() }

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
        addUnique(direct, source.id, { summary: skillSummary(source), direct: source }, 'inline')
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

function addUnique(
  entries: Map<string, CatalogEntry>,
  id: string,
  entry: CatalogEntry,
  owner: string,
): void {
  const existing = entries.get(id)
  if (existing !== undefined) {
    throw new TypeError(
      `duplicate skill '${id}' from '${owner}'; already provided by '${existing.summary.provider}'`,
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
