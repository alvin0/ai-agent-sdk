/** Paired BASE vs PTC analysis for a runner-paired.ts directory (evaluation spec §10–11).
 * Families are the unit of resampling; repeats of one family are never independent samples. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireIntegrityEntries, validateAttempts, type AttemptManifest } from './integrity.ts'

type Usage = { reported?: { totalTokens?: number }; authoritative?: boolean }
type Row = { id: string; arm: 'BASE' | 'PTC'; domain?: string; split: string; repeat: number; status: string; elapsedMs?: number; effects?: number; usage?: Usage; history?: { usage?: Usage }[] }

const dir = resolve(process.argv[2] ?? '')
const sums = JSON.parse(await readFile(resolve(dir, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
requireIntegrityEntries(sums, ['manifest.json', 'runs.jsonl', 'fixtures.json'])
for (const [file, expected] of Object.entries(sums)) {
  if (createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex') !== expected) throw new Error(`Integrity mismatch: ${file}`)
}
const config = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')) as AttemptManifest
const rows = (await readFile(resolve(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Row)
validateAttempts(config, rows, true)

const REVIEW = new Set(['LANG-05', 'LANG-06'])
const scored = rows.filter(row => row.status !== 'unsupported' && !REVIEW.has(row.id))
const domains = [...new Set(scored.map(row => row.id.split('-')[0]!))].sort()
const families = [...new Set(scored.map(row => row.id))].sort()
const passRate = (list: Row[]) => list.length === 0 ? null : list.filter(row => row.status === 'passed').length / list.length
const tokens = (row: Row) => [...(row.history ?? []).map(h => h.usage), row.usage].reduce((n, u) => n + (u?.reported?.totalTokens ?? 0), 0)
const median = (values: number[]) => { const s = values.toSorted((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const quantile = (values: number[], q: number) => { const s = values.toSorted((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]! : null }

// Family average first, then domain average, then equal-weight macro (spec §10).
function macro(arm: 'BASE' | 'PTC', sample: string[]) {
  const rates = domains.map(domain => {
    const inDomain = sample.filter(id => id.startsWith(`${domain}-`))
    const familyRates = inDomain.map(id => passRate(scored.filter(row => row.id === id && row.arm === arm))).filter((r): r is number => r !== null)
    return familyRates.length ? familyRates.reduce((a, b) => a + b, 0) / familyRates.length : null
  }).filter((r): r is number => r !== null)
  return rates.reduce((a, b) => a + b, 0) / rates.length
}
// Seeded stratified family bootstrap of the paired macro difference.
let state = 260927
const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296 }
const draws: number[] = []
for (let i = 0; i < 4000; i++) {
  const sample = domains.flatMap(domain => {
    const inDomain = families.filter(id => id.startsWith(`${domain}-`))
    return inDomain.map(() => inDomain[Math.floor(random() * inDomain.length)]!)
  })
  draws.push(macro('PTC', sample) - macro('BASE', sample))
}
const point = macro('PTC', families) - macro('BASE', families)
const ci = [quantile(draws, 0.025)!, quantile(draws, 0.975)!]

const arm = (name: 'BASE' | 'PTC') => {
  const list = rows.filter(row => row.arm === name && row.status !== 'unsupported')
  return {
    attempts: list.length,
    autoPass: `${String(scored.filter(r => r.arm === name && r.status === 'passed').length)}/${String(scored.filter(r => r.arm === name).length)}`,
    statuses: list.reduce<Record<string, number>>((m, row) => ({ ...m, [row.status]: (m[row.status] ?? 0) + 1 }), {}),
    effects: list.reduce((n, row) => n + (row.effects ?? 0), 0),
    runtimeErrors: list.filter(row => row.status.startsWith('runtime-')).length,
    medianTokens: median(list.map(tokens)), totalTokens: list.reduce((n, row) => n + tokens(row), 0),
    latencyMs: { p50: median(list.map(row => row.elapsedMs ?? 0)), p95: quantile(list.map(row => row.elapsedMs ?? 0), 0.95) },
    usageAuthoritative: list.every(row => row.usage?.authoritative === true
      && (row.history ?? []).every(turn => turn.usage?.authoritative === true)),
  }
}
const perDomain = domains.map(domain => {
  const pick = (name: 'BASE' | 'PTC') => scored.filter(row => row.arm === name && row.id.startsWith(`${domain}-`))
  return { domain, BASE: passRate(pick('BASE')), PTC: passRate(pick('PTC')),
    medianTokens: { BASE: median(pick('BASE').map(tokens)), PTC: median(pick('PTC').map(tokens)) } }
})
const familyLosses = families.map(id => {
  const b = passRate(scored.filter(row => row.id === id && row.arm === 'BASE'))!, p = passRate(scored.filter(row => row.id === id && row.arm === 'PTC'))!
  return { id, BASE: b, PTC: p, delta: p - b }
}).filter(entry => entry.delta !== 0).sort((a, b) => a.delta - b.delta)
// Language is derived from the frozen fixtures, never edited into them: any
// Vietnamese diacritic in prompt or resources marks the family vi-or-mixed.
const fixtures = JSON.parse(await readFile(resolve(dir, 'fixtures.json'), 'utf8')) as { id: string; prompt: string; resources: unknown }[]
const VIETNAMESE = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu
const languageOf = new Map(fixtures.map(entry => [entry.id, VIETNAMESE.test(`${entry.prompt} ${JSON.stringify(entry.resources)}`) ? 'vi-or-mixed' : 'en']))
const perLanguage = ['en', 'vi-or-mixed'].map(language => {
  const pick = (name: 'BASE' | 'PTC') => scored.filter(row => row.arm === name && languageOf.get(row.id) === language)
  return { language, families: families.filter(id => languageOf.get(id) === language).length, BASE: passRate(pick('BASE')), PTC: passRate(pick('PTC')) }
})
const base = arm('BASE'), ptc = arm('PTC')
const MARGIN = 0.05
console.log(JSON.stringify({
  comparisonKind: 'ptc-ablation-on-current-sdk',
  run: dir, families: families.length, domains: domains.length,
  arms: { BASE: base, PTC: ptc },
  macro: { BASE: macro('BASE', families), PTC: macro('PTC', families), difference: point, ci95: ci, method: 'stratified family bootstrap, 4000 draws, seed 260927' },
  perDomain, perLanguage, familyChanges: familyLosses,
  gates: {
    conformanceNoNewViolations: { passed: ptc.effects <= base.effects && ptc.effects === 0, effects: { BASE: base.effects, PTC: ptc.effects } },
    qualityNonInferiorAtMargin5pp: { passed: ci[0]! > -MARGIN, lowerBound: ci[0] },
    newLossesNeedReview: familyLosses.filter(entry => entry.delta < 0).map(entry => entry.id),
  },
  scope: 'author-exposed frozen regression cohort (held-out split, not blind); one model; PTC enabled on every task, not only target workloads',
}, null, 2))
