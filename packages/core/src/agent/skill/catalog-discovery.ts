/** Collect shallow provider metadata before committing a catalog refresh. */
import { skillSummary, validateCandidate, type SkillLookupOptions,
  type SkillProvider, type SkillProviderListOptions } from './definition.ts'
import { captureSkillCatalogSnapshot } from './provider/snapshot.ts'
import type { CapturedSkillProviderPlugin, RuntimeSkillLookupOptions,
  RuntimeSkillSource } from './provider/types.ts'
import { addCatalogBytes, addUnique, isRuntimeProvider, raceAbort,
  summaryOfCandidate, summaryOfRuntimeCandidate, throwIfAborted,
  type CatalogEntry } from './catalog-entries.ts'

interface Collection {
  readonly entries: Map<string, CatalogEntry>
  readonly maxSkills: number
  readonly maxCatalogBytes: number
  readonly isAllowed: (id: string) => boolean
  readonly legacyOptions: SkillProviderListOptions
  readonly runtimeOptions: RuntimeSkillLookupOptions & { readonly allowedSkillIds?: readonly string[] }
}

class CatalogCollector {
  private bytes = 0
  constructor(readonly config: Collection) {}

  add(id: string, value: unknown, entry: CatalogEntry): void {
    if (!this.config.isAllowed(id)) return
    this.bytes = addCatalogBytes(this.bytes, value, this.config.maxCatalogBytes)
    if (this.config.entries.size >= this.config.maxSkills) {
      throw new RangeError(`skill catalog exceeds ${this.config.maxSkills} entries`)
    }
    addUnique(this.config.entries, id, entry)
  }

  async runtime(source: CapturedSkillProviderPlugin, signal: AbortSignal | undefined): Promise<void> {
    const raw = await raceAbort(source.list(this.config.runtimeOptions), signal)
    throwIfAborted(signal)
    const snapshot = captureSkillCatalogSnapshot(source, raw, this.config.maxSkills, this.config.maxCatalogBytes)
    for (let index = 0; index < snapshot.candidates.length; index++) {
      const candidate = snapshot.candidates[index]!
      if (!this.config.isAllowed(candidate.id)) continue
      this.add(candidate.id, candidate, { summary: summaryOfRuntimeCandidate(candidate),
        runtimeProvider: source, reference: snapshot.references[index]! })
    }
  }

  async legacy(source: SkillProvider, signal: AbortSignal | undefined): Promise<void> {
    const candidates = await raceAbort(source.list(this.config.legacyOptions), signal)
    throwIfAborted(signal)
    if (candidates.length > this.config.maxSkills) {
      throw new RangeError(`skill provider '${source.id}' exceeds the ${this.config.maxSkills}-candidate limit`)
    }
    for (const candidate of candidates) {
      validateCandidate(candidate, source.id)
      if (!this.config.isAllowed(candidate.id)) continue
      this.add(candidate.id, candidate, {
        summary: summaryOfCandidate(candidate), provider: source, candidate,
      })
    }
  }
}

export async function collectCatalogEntries(
  sources: readonly RuntimeSkillSource[], config: Collection, signal: SkillLookupOptions['signal'],
): Promise<void> {
  const collector = new CatalogCollector(config)
  for (const source of sources) {
    if (source.kind === 'skill') {
      if (!config.isAllowed(source.id)) continue
      collector.add(source.id, source, { summary: skillSummary(source), direct: source })
    } else if (isRuntimeProvider(source)) {
      await collector.runtime(source, signal)
    } else {
      await collector.legacy(source, signal)
    }
  }
}
