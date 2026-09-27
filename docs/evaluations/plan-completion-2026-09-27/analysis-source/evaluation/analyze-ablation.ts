import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadBundleEvaluation } from './bundle-integrity.ts'
import { loadProseReviews } from './review-integrity.ts'
import { bundleStatistics } from './bundle-statistics.ts'
import type { EvaluationCaseV2 } from './cohort-v2.ts'

const on = await loadBundleEvaluation(process.argv[2] ?? '')
const off = await loadBundleEvaluation(process.argv[3] ?? '')
if (on.config.phase !== 'final' || off.config.phase !== 'ablation' || on.config.provider !== off.config.provider
  || on.config.model !== off.config.model || on.config.repeats !== off.config.repeats) throw new Error('Unmatched ablation configuration')
for (const key of ['cohort', 'seed', 'effort', 'limits', 'candidatePolicy', 'allowedCapabilities', 'preparation']) {
  if (!Object.hasOwn(on.config, key) || !Object.hasOwn(off.config, key) || JSON.stringify(Reflect.get(on.config, key)) !== JSON.stringify(Reflect.get(off.config, key))) throw new Error(`Ablation configuration differs: ${key}`)
}
const onFixtures = JSON.parse(await readFile(resolve(on.dir, 'fixtures.json'), 'utf8')) as EvaluationCaseV2[]
const offFixtures = JSON.parse(await readFile(resolve(off.dir, 'fixtures.json'), 'utf8')) as EvaluationCaseV2[]
if (offFixtures.some(fixture => JSON.stringify(onFixtures.find(test => test.variantId === fixture.variantId)) !== JSON.stringify(fixture))) throw new Error('Ablation fixtures differ')
const onLoaded = JSON.parse(await readFile(resolve(on.dir, 'loaded-bundles.json'), 'utf8')) as { candidate: { sessionModuleSha256: string } }
const offLoaded = JSON.parse(await readFile(resolve(off.dir, 'loaded-bundles.json'), 'utf8')) as typeof onLoaded
if (onLoaded.candidate.sessionModuleSha256 !== offLoaded.candidate.sessionModuleSha256) throw new Error('Ablation SDK differs')
const onReviews = await loadProseReviews(process.argv[4] ?? '', on)
const offReviews = await loadProseReviews(process.argv[5] ?? '', off)
// The OFF review re-presents identical ON outputs with another anonymous partner.
// Retain disagreements rather than selecting the more favorable score.
const referenceReviews = (await readFile(resolve(process.argv[5] ?? '', 'reviews.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
  .map(line => JSON.parse(line) as { status: string; scores?: { variantId: string; repeat: number; arm: string; passed: boolean }[] })
  .filter(row => row.status === 'reviewed').flatMap(row => row.scores ?? []).filter(score => score.arm === 'CANDIDATE')
const referenceReviewDisagreements = referenceReviews.flatMap(score => {
  const original = onReviews.find(review => review.arm === 'CANDIDATE' && review.variantId === score.variantId && review.repeat === score.repeat)
  return original && original.passed !== score.passed ? [{ variantId: score.variantId, repeat: score.repeat,
    originalReviewPassed: original.passed, ablationReferenceReviewPassed: score.passed }] : []
})
const selected = new Set(off.config.selected.map(test => test.variantId))
const onRows = on.rows.filter(row => row.arm === 'CANDIDATE' && selected.has(row.variantId))
if (onRows.length !== off.rows.length) throw new Error('Missing ON ablation counterparts')
const rows = [...onRows, ...off.rows.map(row => ({ ...row, arm: 'BASE' }))]
const scores = [...onReviews.filter(review => review.arm === 'CANDIDATE' && selected.has(review.variantId)), ...offReviews.map(review => ({ ...review, arm: 'BASE' }))]
const report = { comparisonKind: 'final-sdk-feature-on-off-ablation', provider: on.config.provider, model: on.config.model,
  armLabels: { BASE: 'OFF on final SDK', CANDIDATE: 'ON on final SDK' }, onSource: on.dir, offSource: off.dir,
  referenceReviewDisagreements,
  reviewLimitation: 'ON retains its original final-review score; OFF uses its bound anonymous review. Repeated ON-output rating disagreements are disclosed without choosing favorable scores.',
  timingLimitation: 'OFF ran after the interleaved original/final replay; same data, budgets and SDK, but no simultaneous or interleaved OFF measurement. Do not attribute timing drift to PTC.',
  ...bundleStatistics(rows, scores) }
await writeFile(resolve(off.dir, 'on-off-comparison.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ comparisonKind: report.comparisonKind, families: report.families, macroDifference: report.macroDifference, pairedSuccess: report.pairedSuccessEfficiency.pairs }))
