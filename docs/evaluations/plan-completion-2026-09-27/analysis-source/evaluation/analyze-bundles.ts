import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadBundleEvaluation } from './bundle-integrity.ts'
import { bundleStatistics } from './bundle-statistics.ts'
import { loadProseReviews } from './review-integrity.ts'

const evaluation = await loadBundleEvaluation(process.argv[2] ?? '')
const { dir, config, rows } = evaluation
const reviewPath = process.argv[3]
const reviews = reviewPath ? await loadProseReviews(reviewPath, evaluation) : []
const report = { comparisonKind: config.phase === 'ablation' ? 'final-sdk-feature-off-ablation' : 'original-sdk-versus-final-bundle', provider: config.provider, model: config.model,
  reviewSource: reviewPath ?? null, ...bundleStatistics(rows, reviews) }
await writeFile(resolve(dir, reviewPath ? 'reviewed-report.json' : 'automatic-report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ dir, families: report.families, macroDifference: report.macroDifference, gates: report.gates }, null, 2))
