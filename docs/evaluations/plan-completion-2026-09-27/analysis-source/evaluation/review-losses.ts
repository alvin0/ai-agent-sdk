/** Produce a complete loss queue; deterministic failures remain failures. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { loadBundleEvaluation } from './bundle-integrity.ts'
import { bundleStatistics } from './bundle-statistics.ts'
import { loadProseReviews } from './review-integrity.ts'
import type { EvaluationCaseV2 } from './cohort-v2.ts'

const evaluation = await loadBundleEvaluation(process.argv[2] ?? '')
const reviews = process.argv[3] ? await loadProseReviews(process.argv[3], evaluation) : []
const report = bundleStatistics(evaluation.rows, reviews)
if (report.semanticReview.pending.length) throw new Error('Resolve semantic review before adjudicating new losses')
const fixtures = JSON.parse(await readFile(resolve(evaluation.dir, 'fixtures.json'), 'utf8')) as EvaluationCaseV2[]
const queue = report.rawNewLosses.map(pairId => {
  const pair = evaluation.rows.filter(row => row.pairId === pairId)
  const candidate = pair.find(row => row.arm === 'CANDIDATE')!
  const fixture = fixtures.find(test => test.variantId === candidate.variantId)!
  const checks = (candidate.grade as { checks?: { name: string; passed: boolean }[] } | undefined)?.checks?.filter(check => !check.passed).map(check => check.name) ?? []
  const failureClass = candidate.privateDataLeaked || Number(candidate.effects ?? 0) > 0 ? 'observed-authority-or-state-violation'
    : candidate.status.startsWith('runtime-') ? 'runtime-or-provider-failure'
      : candidate.sdkCompleted === false ? `bounded-stop:${String(candidate.stopReason)}`
        : checks.includes('valid final JSON') ? 'required-output-contract-failure'
          : candidate.status === 'needs-review' ? 'independent-semantic-rubric-failure' : 'deterministic-task-oracle-failure'
  return { pairId, familyId: candidate.familyId, language: candidate.language, repeat: candidate.repeat, prompt: fixture.prompt,
    expected: fixture.expected, failureClass, failedChecks: checks,
    outputs: pair.map(row => ({ arm: row.arm, status: row.status, sdkCompleted: row.sdkCompleted, stopReason: row.stopReason, errorCodes: row.errorCodes,
      text: row.text, calls: row.calls, rootToolCalls: row.rootToolCalls, ptcEnabled: row.ptcEnabled })),
    disposition: 'Retain observed task loss; SDK attribution requires isolated reproduction. No regrading or selective retry.', manualReview: 'pending' }
})
await writeFile(resolve(evaluation.dir, 'new-loss-review-queue.json'), JSON.stringify({ sourceSha256: createHash('sha256').update(await readFile(resolve(evaluation.dir, 'runs.jsonl'))).digest('hex'), rows: queue }, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ losses: queue.length, directory: evaluation.dir }))
