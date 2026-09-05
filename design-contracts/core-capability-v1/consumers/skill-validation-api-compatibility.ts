import {
  validateCandidate,
  validateSkillResourcePath,
} from '@compat/skill-validation'

type Candidate = Parameters<typeof validateCandidate>[0]

export function validateExternalSkillCandidate(candidate: Candidate): void {
  const candidateResult: void = validateCandidate(candidate, 'filesystem')
  const pathResult: void = validateSkillResourcePath('references/guide.md', candidate.id)
  void candidateResult
  void pathResult
}
