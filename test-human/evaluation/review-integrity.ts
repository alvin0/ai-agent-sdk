import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireIntegrityEntries } from './integrity.ts'
import { loadBundleEvaluation, type BundleManifest, type BundleRecord } from './bundle-integrity.ts'
import type { ReviewScore } from './bundle-statistics.ts'
import type { EvaluationCaseV2 } from './cohort-v2.ts'
import { validateBlindReview } from './review-prose.ts'

/** Reviews are input-bound evidence, not permission to override deterministic failures. */
export async function loadProseReviews(reviewPath: string, evaluation: { dir: string; config: BundleManifest; rows: BundleRecord[] }): Promise<ReviewScore[]> {
  const dir = resolve(reviewPath)
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const sums = JSON.parse(await readFile(resolve(dir, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
  requireIntegrityEntries(sums, ['manifest.json', 'reviews.jsonl', 'summary.json', 'review-prose.ts'])
  for (const [file, sum] of Object.entries(sums)) {
    if (file.includes('..') || file.startsWith('/') || hash(await readFile(resolve(dir, file))) !== sum) throw new Error('Review integrity mismatch')
  }
  const manifest = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')) as { inputHash: string; reviewer: { model: string }; harnessHash: string; reference?: string; referenceHash?: string }
  if (manifest.inputHash !== hash(await readFile(resolve(evaluation.dir, 'runs.jsonl')))
    || manifest.reviewer.model === evaluation.config.model || manifest.harnessHash !== sums['review-prose.ts']) throw new Error('Review source or independence mismatch')
  const fixtures = JSON.parse(await readFile(resolve(evaluation.dir, 'fixtures.json'), 'utf8')) as EvaluationCaseV2[]
  if (evaluation.config.phase === 'ablation') {
    if (!manifest.reference || !manifest.referenceHash) throw new Error('Ablation review requires a bound candidate reference')
    const reference = await loadBundleEvaluation(manifest.reference)
    if (reference.config.provider !== evaluation.config.provider || reference.config.model !== evaluation.config.model
      || manifest.referenceHash !== hash(await readFile(resolve(reference.dir, 'runs.jsonl')))) throw new Error('Ablation reference mismatch')
    const referenceFixtures = JSON.parse(await readFile(resolve(reference.dir, 'fixtures.json'), 'utf8')) as EvaluationCaseV2[]
    if (fixtures.some(fixture => JSON.stringify(referenceFixtures.find(test => test.variantId === fixture.variantId)) !== JSON.stringify(fixture))) throw new Error('Ablation reference fixtures mismatch')
  }
  const rows = (await readFile(resolve(dir, 'reviews.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
    pairId: string; variantId: string; repeat: number; status: string; labels: { A: string; B: string }; review: unknown; scores: ReviewScore[]
  })
  const scores: ReviewScore[] = [], seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.variantId}:${row.repeat}`
    const fixture = fixtures.find(test => test.variantId === row.variantId)
    if (seen.has(key) || row.pairId !== key || !fixture?.reviewRubric
      || !evaluation.rows.some(attempt => attempt.pairId === key)) throw new Error('Unexpected review pairing')
    seen.add(key)
    if (row.status === 'review-error') continue
    if (row.status !== 'reviewed' || row.labels.A === row.labels.B || row.scores.length !== 2) throw new Error('Invalid review record')
    const expectedArms = evaluation.config.phase === 'ablation' ? ['OFF', 'CANDIDATE'] : ['BASE', 'CANDIDATE']
    if (![row.labels.A, row.labels.B].every(arm => expectedArms.includes(arm))) throw new Error('Unexpected blind labels')
    const review = validateBlindReview(row.review, fixture.reviewRubric)
    for (const label of ['A', 'B'] as const) {
      const matching = row.scores.filter(score => score.arm === row.labels[label])
      if (matching.length !== 1 || matching[0]!.variantId !== row.variantId || matching[0]!.repeat !== row.repeat
        || matching[0]!.passed !== review[label].criteria.every(criterion => criterion.passed)) throw new Error('Review score does not match rubric')
      if (evaluation.config.arms.includes(matching[0]!.arm)) scores.push(matching[0]!)
    }
  }
  return scores
}
