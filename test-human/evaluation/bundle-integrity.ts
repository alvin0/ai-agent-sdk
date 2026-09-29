import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireIntegrityEntries } from './integrity.ts'

export interface BundleManifest {
  schemaVersion: number
  phase: string
  provider: string
  model: string
  repeats: number
  arms: readonly string[]
  expectedAttempts: number
  selected: readonly { id: string; variantId: string; familyId: string; domain: string; split: string; language: string; comparison: string; unsupported: string | null }[]
}
export interface BundleRecord {
  id: string
  variantId: string
  familyId: string
  domain: string
  language: string
  split: string
  comparison: string
  arm: string
  repeat: number
  pairId: string
  position: number
  provider: string
  model: string
  startedAt: string
  finishedAt: string
  status: string
  [key: string]: unknown
}

export function validateBundleCoverage(config: BundleManifest, rows: readonly BundleRecord[]): void {
  if (config.schemaVersion !== 2 || !Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 10
    || config.selected.length === 0 || !['pilot', 'final', 'ablation'].includes(config.phase)) throw new Error('Invalid bundle manifest')
  const arms = config.phase === 'ablation' ? ['OFF'] : ['BASE', 'CANDIDATE']
  if (JSON.stringify(config.arms) !== JSON.stringify(arms)) throw new Error('Unexpected arms')
  const expected = new Map<string, { test: BundleManifest['selected'][number]; position: number }>()
  const variants = new Set<string>()
  for (const test of config.selected) {
    if (variants.has(test.variantId) || test.id !== test.familyId || test.variantId !== `${test.familyId}:${test.language}`
      || !['en', 'vi'].includes(test.language) || !['development', 'calibration', 'held-out'].includes(test.split)
      || !['common', 'feature'].includes(test.comparison) || typeof test.domain !== 'string') throw new Error('Invalid selected variant')
    variants.add(test.variantId)
  }
  const key = (variant: string, repeat: number, arm: string) => JSON.stringify([variant, repeat, arm])
  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const schedule = [...config.selected.slice(repeat % config.selected.length), ...config.selected.slice(0, repeat % config.selected.length)]
    for (const [index, test] of schedule.entries()) {
      if (test.unsupported && repeat > 0) continue
      const order = (index + repeat) % 2 ? [...arms].reverse() : arms
      order.forEach((arm, position) => expected.set(key(test.variantId, repeat, arm), { test, position }))
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const identity = key(row.variantId, row.repeat, row.arm)
    const target = expected.get(identity)
    if (seen.has(identity)) throw new Error('Duplicate attempt')
    seen.add(identity)
    if (!target || row.id !== target.test.id || row.familyId !== target.test.familyId || row.domain !== target.test.domain
      || row.language !== target.test.language || row.split !== target.test.split || row.comparison !== target.test.comparison
      || row.position !== target.position || row.pairId !== `${row.variantId}:${row.repeat}`
      || row.provider !== config.provider || row.model !== config.model
      || !['passed', 'failed', 'needs-review', 'unsupported', 'runtime-error', 'runtime-failed'].includes(row.status)
      || (row.status === 'unsupported') !== !!target.test.unsupported
      || !Number.isFinite(Date.parse(row.startedAt)) || Date.parse(row.finishedAt) < Date.parse(row.startedAt)
      || !Number.isFinite(Date.parse(row.finishedAt))) throw new Error('Unexpected attempt or pairing metadata')
  }
  if (seen.size !== expected.size || config.expectedAttempts !== expected.size) throw new Error(`Incomplete cohort: ${seen.size}/${expected.size}`)
}

export async function loadBundleEvaluation(path: string) {
  const dir = resolve(path)
  const sums = JSON.parse(await readFile(resolve(dir, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
  requireIntegrityEntries(sums, ['manifest.json', 'fixtures.json', 'runs.jsonl', 'summary.json', 'loaded-bundles.json', 'cases.ts', 'grading.ts', 'cohort-v2.ts', 'grading-v2.ts', 'bundle-worker.ts', 'runner-bundles.ts'])
  for (const [file, sum] of Object.entries(sums)) {
    if (file.includes('..') || file.startsWith('/') || createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex') !== sum) throw new Error(`Integrity mismatch: ${file}`)
  }
  const config = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')) as BundleManifest
  if (Reflect.get(config, 'cohort') === 'neutral-v2.2-matched-en-vi') requireIntegrityEntries(sums, ['bundle-protocol.ts'])
  const rows = (await readFile(resolve(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as BundleRecord)
  validateBundleCoverage(config, rows)
  return { dir, config, rows }
}
