import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireIntegrityEntries, validateAttempts } from './integrity.ts'

type Row = { id: string; domain?: string; split: string; repeat: number; status: string; elapsedMs?: number;
  effects?: number; calls?: unknown[]; usage?: Usage; history?: { usage?: Usage }[]; grade?: { checks: { name: string; passed: boolean }[] } }
type Usage = { reported?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }; authoritative?: boolean }
async function load(path: string) {
  const dir = resolve(path)
  const integrity = JSON.parse(await readFile(resolve(dir, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
  requireIntegrityEntries(integrity, ['manifest.json', 'runs.jsonl'])
  for (const [file, expected] of Object.entries(integrity)) {
    const actual = createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex')
    if (actual !== expected) throw new Error(`Integrity mismatch: ${file}`)
  }
  const config = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8'))
  const rows = (await readFile(resolve(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
  validateAttempts(config, rows)
  return { dir, config, rows }
}
function quantile(values: number[], q: number) {
  const sorted = values.toSorted((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!
}
function stats(rows: Row[]) {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1
  const executed = rows.filter(r => r.status !== 'unsupported')
  const autoscore = executed.filter(r => !['LANG-05', 'LANG-06'].includes(r.id))
  const usage = executed.flatMap(r => [...(r.history ?? []).map(h => h.usage), r.usage]).filter((u): u is Usage => !!u)
  const failures: Record<string, number> = {}
  for (const row of executed) {
    const categories = new Set<string>((row.grade?.checks ?? []).filter(c => !c.passed).map(c =>
      c.name === 'valid final JSON' ? 'format' : c.name.startsWith('semantic field:') || c.name === 'source quote preserved exactly' ? 'factual-or-source' :
      c.name.startsWith('no unauthorized') || c.name.startsWith('no private') ? 'authority-or-leakage' : 'constraint'))
    if (row.status.startsWith('runtime-')) categories.add('runtime')
    for (const category of categories) failures[category] = (failures[category] ?? 0) + 1
  }
  return { counts, executed: executed.length, automaticallyScored: autoscore.length,
    failureCategories: failures,
    autoPassRate: autoscore.length ? autoscore.filter(r => r.status === 'passed').length / autoscore.length : null,
    effects: executed.reduce((n, r) => n + (r.effects ?? 0), 0),
    latencyMs: { median: quantile(executed.map(r => r.elapsedMs!).filter(Number.isFinite), .5), p95: quantile(executed.map(r => r.elapsedMs!).filter(Number.isFinite), .95) },
    reportedTokensIncludingHistory: usage.reduce((total, u) => ({ input: total.input + (u.reported?.inputTokens ?? 0), output: total.output + (u.reported?.outputTokens ?? 0), total: total.total + (u.reported?.totalTokens ?? 0),
      cacheRead: total.cacheRead + (u.reported?.cacheReadTokens ?? 0), cacheWrite: total.cacheWrite + (u.reported?.cacheWriteTokens ?? 0), reasoning: total.reasoning + (u.reported?.reasoningTokens ?? 0) }), { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    authoritativeUsageRecords: usage.filter(u => u.authoritative).length, usageRecords: usage.length,
    runsWithoutUsage: executed.filter(r => !r.usage).length }
}
const beforePath = process.argv[2]
if (!beforePath) throw new Error('Usage: analyze.ts <baseline-dir> [after-dir]')
const before = await load(beforePath)
const domains = [...new Set(before.rows.map(r => r.id.split('-')[0]!))]
const macro = (rows: Row[]) => {
  const rates = domains.map(domain => stats(rows.filter(r => r.id.startsWith(`${domain}-`))).autoPassRate).filter((r): r is number => r !== null)
  return { evaluatedDomains: rates.length, equalDomainAutoPassRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    note: 'Automatic factual/constraint checks only. Pending prose review remains separate, so this is not overall human quality.' }
}
const report: Record<string, unknown> = { schemaVersion: 1, baseline: before.config,
  overall: stats(before.rows), heldOut: stats(before.rows.filter(r => r.split === 'held-out')),
  macro: macro(before.rows.filter(r => r.split === 'held-out')),
  domains: Object.fromEntries(domains.map(domain => [domain, stats(before.rows.filter(r => r.id.startsWith(`${domain}-`)))])),
  notes: ['Author-exposed synthetic cohort; not blind or production evidence.', 'Prose requires human review; unsupported is reported separately.', 'Latency includes history turns. All attempts retained. Tokens are not USD cost.'] }
if (process.argv[3]) {
  const after = await load(process.argv[3])
  for (const key of ['seed', 'repeats', 'provider', 'model', 'effort', 'lockfileHash', 'limits', 'harnessHashes', 'selected']) {
    if (JSON.stringify(before.config[key]) !== JSON.stringify(after.config[key])) throw new Error(`Unpaired configuration: ${key}`)
  }
  const baselineRows = before.rows.filter(r => r.split === 'held-out' && r.status !== 'unsupported' && !['LANG-05', 'LANG-06'].includes(r.id))
  const afterIndex = new Map(after.rows.map(r => [`${r.id}:${r.repeat}`, r]))
  const familyDeltas = new Map<string, number[]>()
  const pairs = baselineRows.map(b => {
    const a = afterIndex.get(`${b.id}:${b.repeat}`)
    if (!a) throw new Error(`Missing paired result: ${b.id}:${b.repeat}`)
    const delta = Number(a.status === 'passed') - Number(b.status === 'passed')
    familyDeltas.set(b.id, [...(familyDeltas.get(b.id) ?? []), delta])
    return { id: b.id, repeat: b.repeat, before: b.status, after: a.status, delta }
  })
  const strata = domains.map(domain => [...familyDeltas.entries()].filter(([id]) => id.startsWith(`${domain}-`)).map(([, values]) => values.reduce((a, b) => a + b, 0) / values.length)).filter(values => values.length)
  let state = before.config.seed >>> 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const bootstrap = Array.from({ length: 5000 }, () => strata.reduce((total, means) => total + means.reduce(sum => sum + means[Math.floor(random() * means.length)]!, 0) / means.length, 0) / strata.length)
  report.comparison = { after: after.config, afterOverall: stats(after.rows), pairs,
    qualityDelta: strata.reduce((total, means) => total + means.reduce((a, b) => a + b, 0) / means.length, 0) / strata.length,
    familyBootstrap95: [quantile(bootstrap, .025), quantile(bootstrap, .975)],
    note: 'Paired by family/repeat; confidence interval resamples families within domains, then gives domains equal weight. Sequential-before-after retains provider/time drift as a limitation. No efficiency claim from failed tasks.' }
}
const output = resolve(before.dir, process.argv[3] ? `comparison-${Date.now()}.json` : 'analysis.json')
await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ output, overall: report.overall, heldOut: report.heldOut }, null, 2))
