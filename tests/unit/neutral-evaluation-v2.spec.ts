import { describe, expect, it } from 'vitest'
import { evaluationCasesV2 } from '../../test-human/evaluation/cohort-v2.ts'
import { applyInvoicePatch, gradeAnswerV2 } from '../../test-human/evaluation/grading-v2.ts'
import { validateBundleCoverage, type BundleManifest, type BundleRecord } from '../../test-human/evaluation/bundle-integrity.ts'
import { bundleStatistics } from '../../test-human/evaluation/bundle-statistics.ts'
import { validateBlindReview } from '../../test-human/evaluation/review-prose.ts'
import { fixtureSizeAudit } from '../../test-human/evaluation/bundle-protocol.ts'
import { loadProseReviews } from '../../test-human/evaluation/review-integrity.ts'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

describe('neutral evaluation v2 protocol', () => {
  it('binds independent prose scores to exact raw outputs and cannot override a deterministic failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-review-proof-'))
    try {
      const dir = join(root, 'source'), reviewDir = join(root, 'review')
      await mkdir(dir); await mkdir(reviewDir)
      const raw = 'immutable paired outputs\n'
      const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
      const rubric = ['preserved facts']
      const criterion = { criterion: rubric[0], passed: true, reason: 'Source facts match.' }
      const record = { pairId: 'LANG-05:en:0', variantId: 'LANG-05:en', repeat: 0, status: 'reviewed', labels: { A: 'BASE', B: 'CANDIDATE' },
        review: { A: { criteria: [criterion] }, B: { criteria: [criterion] } }, scores: ['BASE', 'CANDIDATE'].map(arm => ({ variantId: 'LANG-05:en', repeat: 0, arm, passed: true })) }
      await writeFile(join(dir, 'runs.jsonl'), raw)
      await writeFile(join(dir, 'fixtures.json'), JSON.stringify([{ variantId: 'LANG-05:en', reviewRubric: rubric }]))
      await writeFile(join(reviewDir, 'review-prose.ts'), 'frozen reviewer source')
      await writeFile(join(reviewDir, 'manifest.json'), JSON.stringify({ inputHash: hash(raw), harnessHash: hash('frozen reviewer source'), reviewer: { model: 'different-reviewer' } }))
      await writeFile(join(reviewDir, 'reviews.jsonl'), JSON.stringify(record) + '\n')
      await writeFile(join(reviewDir, 'summary.json'), '{}')
      const sums = Object.fromEntries(await Promise.all(['review-prose.ts', 'manifest.json', 'reviews.jsonl', 'summary.json'].map(async file => [file, hash(await readFile(join(reviewDir, file)))])))
      await writeFile(join(reviewDir, 'SHA256SUMS.json'), JSON.stringify(sums))
      const config: BundleManifest = { schemaVersion: 2, phase: 'final', provider: 'fixture', model: 'candidate', repeats: 1, arms: ['BASE', 'CANDIDATE'], expectedAttempts: 2, selected: [] }
      const rows = ['BASE', 'CANDIDATE'].map(arm => ({ variantId: 'LANG-05:en', familyId: 'LANG-05', domain: 'LANG', comparison: 'common', arm, repeat: 0, pairId: record.pairId, status: arm === 'BASE' ? 'needs-review' : 'failed' })) as BundleRecord[]
      const scores = await loadProseReviews(reviewDir, { dir, config, rows })
      expect(scores).toHaveLength(2)
      expect(bundleStatistics(rows, scores).perArm.CANDIDATE?.passed).toBe(0)
      await writeFile(join(dir, 'runs.jsonl'), 'changed outputs\n')
      await expect(loadProseReviews(reviewDir, { dir, config, rows })).rejects.toThrow('source or independence mismatch')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps raw fixture results admissible in both arms while the separate model-facing spill limit remains bounded', () => {
    expect(fixtureSizeAudit(evaluationCasesV2()).largestRawResult?.bytes).toBeGreaterThan(8192)
    expect(() => fixtureSizeAudit(evaluationCasesV2(), 8192)).toThrow('cannot be read')
  })
  it('requires every blind semantic criterion and rejects fabricated or duplicate scores', () => {
    const criteria = ['fact preserved', 'no invented facts']
    const scores = criteria.map(criterion => ({ criterion, passed: true, reason: 'supported by supplied text' }))
    const valid = { A: { criteria: scores }, B: { criteria: scores } }
    expect(validateBlindReview(valid, criteria)).toEqual(valid)
    expect(() => validateBlindReview({ ...valid, A: { criteria: [scores[0]] } }, criteria)).toThrow('Incomplete')
    expect(() => validateBlindReview({ ...valid, A: { criteria: [scores[0], scores[0]] } }, criteria)).toThrow('duplicate')
    expect(() => validateBlindReview({ ...valid, A: { criteria: scores.map(score => ({ ...score, passed: 'true' })) } }, criteria)).toThrow('Invalid')
  })
  it('balances matched languages within all 60 families without treating translations as new families', () => {
    const tests = evaluationCasesV2()
    expect(tests).toHaveLength(120)
    expect(new Set(tests.map(test => test.familyId)).size).toBe(60)
    expect(new Set(tests.map(test => test.variantId)).size).toBe(120)
    for (const family of new Set(tests.map(test => test.familyId))) {
      const pair = tests.filter(test => test.familyId === family)
      expect(pair.map(test => test.language)).toEqual(['en', 'vi'])
      expect(pair[0]?.expected).toEqual(pair[1]?.expected)
      expect(pair[0]?.resources).toEqual(pair[1]?.resources)
      expect(pair[0]?.collections).toEqual(pair[1]?.collections)
      expect(pair[0]?.split).toBe(pair[1]?.split)
    }
    for (const domain of new Set(tests.map(test => test.domain))) {
      expect(new Set(tests.filter(test => test.domain === domain && test.split === 'held-out' && test.comparison === 'common').map(test => test.familyId)).size).toBeGreaterThanOrEqual(2)
    }
  })

  it('applies alternative valid patches but refuses wrong target, context and hunk counts', () => {
    const source = 'export function total(q, p, d) {\n  return q + p * (1 - d);\n}\n'
    const patch = '--- a/invoice.mjs\n+++ b/invoice.mjs\n@@ -1,3 +1,3 @@\n export function total(q, p, d) {\n-  return q + p * (1 - d);\n+  return (q * p) - (q * p * d);\n }\n'
    expect(applyInvoicePatch(source, patch)).toContain('return (q * p) - (q * p * d);')
    expect(() => applyInvoicePatch(source, patch.replaceAll('invoice.mjs', '../outside.mjs'))).toThrow('target')
    expect(() => applyInvoicePatch(source, patch.replace('q + p', 'q - p'))).toThrow('context')
    expect(() => applyInvoicePatch(source, patch.replace('-1,3', '-1,4'))).toThrow('counts')
  })

  it('cannot count structural prose, missing compaction or private-data leaks as semantic success', async () => {
    const tests = evaluationCasesV2()
    const prose = tests.find(test => test.id === 'LANG-06')!
    expect((await gradeAnswerV2(prose, '{"sentence":"Done."}', 0)).status).toBe('needs-review')
    const history = tests.find(test => test.id === 'BASIC-06')!
    expect((await gradeAnswerV2(history, '{"capacity":9,"owner":"Linh"}', 0, { compactionSucceeded: false })).status).toBe('failed')
    const contacts = tests.find(test => test.id === 'SUP-03')!
    expect((await gradeAnswerV2(contacts, '{"billing":2,"technical":1}', 0, { privateDataLeaked: true })).status).toBe('failed')
  })

  it('rejects substitutions, duplicates and wrong arm order even when the row count matches', () => {
    const config: BundleManifest = { schemaVersion: 2, phase: 'final', provider: 'fixture', model: 'm', repeats: 1, arms: ['BASE', 'CANDIDATE'], expectedAttempts: 2,
      selected: [{ id: 'CODE-04', familyId: 'CODE-04', variantId: 'CODE-04:en', domain: 'CODE', language: 'en', split: 'held-out', comparison: 'common', unsupported: null }] }
    const row: BundleRecord = { id: 'CODE-04', familyId: 'CODE-04', variantId: 'CODE-04:en', domain: 'CODE', language: 'en', split: 'held-out', comparison: 'common', arm: 'BASE', repeat: 0, pairId: 'CODE-04:en:0', position: 0, provider: 'fixture', model: 'm', status: 'passed', startedAt: '2026-09-27T00:00:00Z', finishedAt: '2026-09-27T00:00:01Z' }
    const candidate = { ...row, arm: 'CANDIDATE', position: 1 }
    expect(() => validateBundleCoverage(config, [row, candidate])).not.toThrow()
    expect(() => validateBundleCoverage(config, [row, row])).toThrow('Duplicate')
    expect(() => validateBundleCoverage(config, [row, { ...candidate, language: 'vi' }])).toThrow('Unexpected')
    expect(() => validateBundleCoverage(config, [{ ...row, position: 1 }, candidate])).toThrow('Unexpected')
    expect(() => validateBundleCoverage(config, [row])).toThrow('Incomplete')
  })

  it('clusters languages in families and excludes failed pairs from efficiency conclusions', () => {
    const rows: BundleRecord[] = ['en', 'vi'].flatMap(language => ['BASE', 'CANDIDATE'].map(arm => ({ id: 'DATA-04', familyId: 'DATA-04', variantId: `DATA-04:${language}`, domain: 'DATA', language, comparison: 'common', split: 'held-out', arm, repeat: 0, pairId: `DATA-04:${language}:0`, position: arm === 'BASE' ? 0 : 1, provider: 'fixture', model: 'm', startedAt: '2026-09-27T00:00:00Z', finishedAt: '2026-09-27T00:00:01Z', status: arm === 'CANDIDATE' && language === 'vi' ? 'failed' : 'passed', usage: { reported: { totalTokens: 100 }, authoritative: true }, effects: 0, privateDataLeaked: false, elapsedMs: 10 })))
    const report = bundleStatistics(rows)
    expect(report.families).toBe(1)
    expect(report.macroDifference.point).toBe(-.5)
    expect(report.macroDifference.familyUncertaintyEstimable).toBe(false)
    expect(report.macroDifference.ci95).toEqual([null, null])
    expect(report.pairedSuccessEfficiency.pairs).toBe(1)
    expect(report.rawNewLosses).toEqual(['DATA-04:vi:0'])
    expect(report.gates.qualityNonInferiorAtMargin5pp).toBe(false)
    expect(report.gates.zeroObservedEffectsOrPrivateLeaks).toBe(true)
    const unobserved = rows.map(({ effects: _effects, privateDataLeaked: _privacy, ...row }) => row)
    expect(bundleStatistics(unobserved).gates.zeroObservedEffectsOrPrivateLeaks).toBe(false)
    expect(bundleStatistics([]).gates.zeroObservedEffectsOrPrivateLeaks).toBe(false)
    const cached = bundleStatistics([{ ...rows[0]!, usage: { reported: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 20, reasoningTokens: 2, totalTokens: 28 }, authoritative: true } }])
    expect(cached.perArm.BASE?.usageTotals).toMatchObject({ inputTokens: 5, cacheReadTokens: 20, reasoningTokens: 2, totalTokens: 28 })
  })
})
