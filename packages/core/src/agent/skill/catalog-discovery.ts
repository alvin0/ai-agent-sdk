/** Collect shallow provider metadata before committing a catalog refresh. */
import {
  MAX_SKILL_CANDIDATES, skillSummary, validateCandidate, SkillCandidateValidationError,
  type SkillCandidateRejectionReason,
  type SkillLookupOptions,
  type SkillProvider, type SkillProviderListOptions } from './definition.ts'
import { emitSkillCandidateDiagnostic, type SkillDiagnosticObserver } from './catalog-diagnostics.ts'
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
  readonly strictCandidates: boolean
  readonly onDiagnostic: SkillDiagnosticObserver | undefined
  readonly isAllowed: (id: string) => boolean
  readonly legacyOptions: SkillProviderListOptions
  readonly runtimeOptions: RuntimeSkillLookupOptions & { readonly allowedSkillIds?: readonly string[] }
}

class CatalogCollector {
  private bytes = 0
  constructor(readonly config: Collection) {}

  add(
    id: string,
    value: unknown,
    entry: CatalogEntry,
    candidate?: { readonly providerId: string; readonly raw: unknown },
  ): void {
    if (!this.config.isAllowed(id)) return
    if (candidate !== undefined) {
      // Strict mode reports the same diagnostic, then fails with the legacy error.
      if (this.config.entries.has(id)) {
        this.reject(candidate.providerId, candidate.raw, 'duplicate-id',
          () => addUnique(this.config.entries, id, entry))
        return
      }
      if (this.config.entries.size >= this.config.maxSkills) {
        this.reject(candidate.providerId, candidate.raw, 'candidate-limit', () => {
          throw new RangeError(`skill catalog exceeds ${this.config.maxSkills} entries`)
        })
        return
      }
      let bytes: number
      try { bytes = addCatalogBytes(this.bytes, value, this.config.maxCatalogBytes) }
      catch (error: unknown) {
        this.reject(candidate.providerId, candidate.raw, 'catalog-byte-limit', () => { throw error })
        return
      }
      this.bytes = bytes
      this.config.entries.set(id, entry)
      return
    }
    this.bytes = addCatalogBytes(this.bytes, value, this.config.maxCatalogBytes)
    if (this.config.entries.size >= this.config.maxSkills) {
      throw new RangeError(`skill catalog exceeds ${this.config.maxSkills} entries`)
    }
    addUnique(this.config.entries, id, entry)
  }

  async runtime(source: CapturedSkillProviderPlugin, signal: AbortSignal | undefined): Promise<void> {
    const raw = await raceAbort(source.list(this.config.runtimeOptions), signal)
    throwIfAborted(signal)
    const snapshot = captureSkillCatalogSnapshot(source, raw, {
      maxSkills: this.config.maxSkills,
      maxBytes: this.config.maxCatalogBytes,
      ...(this.config.onDiagnostic === undefined ? {} : { onDiagnostic: this.config.onDiagnostic }),
      strictCandidates: this.config.strictCandidates,
    })
    for (let index = 0; index < snapshot.candidates.length; index++) {
      const candidate = snapshot.candidates[index]!
      if (!this.config.isAllowed(candidate.id)) continue
      this.add(candidate.id, candidate, { summary: summaryOfRuntimeCandidate(candidate),
        runtimeProvider: source, reference: snapshot.references[index]! }, { providerId: source.id, raw: candidate })
    }
  }

  async legacy(source: SkillProvider, signal: AbortSignal | undefined): Promise<void> {
    const candidates = await raceAbort(source.list(this.config.legacyOptions), signal)
    throwIfAborted(signal)
    if (!Array.isArray(candidates)) {
      throw new TypeError(`skill provider '${source.id}' returned an invalid candidate list`)
    }
    if (this.config.strictCandidates && candidates.length > this.config.maxSkills) {
      throw new RangeError(`skill provider '${source.id}' exceeds the ${this.config.maxSkills}-candidate limit`)
    }
    for (let index = 0; index < Math.min(candidates.length, MAX_SKILL_CANDIDATES); index++) {
      const candidate = candidates[index] as unknown
      try { validateCandidate(candidate as Parameters<typeof validateCandidate>[0], source.id) }
      catch (error: unknown) {
        if (this.config.strictCandidates) throw error
        const reason = error instanceof SkillCandidateValidationError ? error.reason : 'candidate-invalid'
        this.reject(source.id, candidate, reason)
        continue
      }
      const valid = candidate as Parameters<typeof validateCandidate>[0]
      if (!this.config.isAllowed(valid.id)) continue
      // `add` enforces `maxSkills` against admitted entries, so invalid or
      // disallowed candidates earlier in the list do not consume the limit.
      this.add(valid.id, valid, {
        summary: summaryOfCandidate(valid), provider: source, candidate: valid,
      }, { providerId: source.id, raw: candidate })
    }
    if (candidates.length > MAX_SKILL_CANDIDATES) {
      this.reject(source.id, candidates[MAX_SKILL_CANDIDATES], 'candidate-limit')
    }
  }

  private reject(
    providerId: string, candidate: unknown, reason: SkillCandidateRejectionReason,
    strictFailure?: () => void,
  ): void {
    emitSkillCandidateDiagnostic(this.config.onDiagnostic, providerId, candidate, reason)
    if (this.config.strictCandidates) {
      strictFailure?.()
      throw new TypeError(`skill provider '${providerId}' candidate was rejected: ${reason}`)
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
