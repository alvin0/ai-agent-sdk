import {
  MAX_SKILL_DIAGNOSTIC_ID_CHARS,
  SKILL_CANDIDATE_DIAGNOSTIC_CODE,
  type SkillCandidateRejectionReason,
  type SkillCatalogDiagnostic,
} from './definition.ts'

export type SkillDiagnosticObserver = (diagnostic: SkillCatalogDiagnostic) => void

export function emitSkillCandidateDiagnostic(
  observer: SkillDiagnosticObserver | undefined,
  providerId: string,
  candidate: unknown,
  reason: SkillCandidateRejectionReason,
): void {
  if (observer === undefined) return
  const boundedProvider = boundedIdentifier(providerId) ?? 'unknown'
  const candidateId = candidateIdentifier(candidate)
  const diagnostic: SkillCatalogDiagnostic = Object.freeze({
    type: 'skill-candidate-rejected',
    code: SKILL_CANDIDATE_DIAGNOSTIC_CODE,
    providerId: boundedProvider,
    ...(candidateId === undefined ? {} : { candidateId }),
    reason,
  })
  try { observer(diagnostic) } catch { /* A diagnostic observer never disables skill discovery. */ }
}

export function candidateIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  let id: unknown
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'id')
    id = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch { return undefined }
  return boundedIdentifier(id)
}

export function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bounded = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_SKILL_DIAGNOSTIC_ID_CHARS)
  return bounded.length === 0 ? undefined : bounded
}
