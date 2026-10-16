import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Result } from './execute.ts'
import type { Metrics } from './metrics.ts'

type AnalysisRun = Pick<Result, 'task' | 'arm' | 'score' | 'pass'> & { status: string; metrics: Metrics | null }

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  if (!sorted.length) return null
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const distribution = (values: (number | null)[]) => {
  if (values.some(value => value === null)) return { mean: null, median: null }
  return { mean: mean(values as number[]), median: median(values as number[]) }
}

export function summarize(runs: AnalysisRun[]) {
  return { n: runs.length, passRate: mean(runs.map(run => Number(run.pass))),
    score: distribution(runs.map(run => run.score)),
    tokens: distribution(runs.map(run => run.metrics?.totalTokens ?? null)),
    leadCalls: distribution(runs.map(run => run.metrics?.leadModelCalls ?? null)),
    totalCalls: distribution(runs.map(run => run.metrics?.totalModelCalls ?? null)),
    wallMs: distribution(runs.map(run => run.metrics?.wallMs ?? null)),
    spawns: distribution(runs.map(run => run.metrics?.spawns ?? null)),
    wastedLeadTurns: distribution(runs.map(run => run.metrics?.wastedLeadTurns ?? null)),
    errors: runs.reduce((sum, run) => sum + (run.metrics?.errors.length ?? 1), 0),
    capHits: Object.fromEntries(['tokens', 'turns', 'toolCalls'].map(cap => [cap,
      runs.filter(run => run.metrics?.capHits?.[cap as keyof Metrics['capHits']]).length])),
    timeouts: runs.filter(run => run.status === 'timeout').length }
}

async function load(directory: string) {
  const names = (await readdir(directory)).filter(name => /\.(single|team|collab)\.\d+\.json$/.test(name))
  const runs = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const fatal = (await readdir(directory)).filter(name => name.endsWith('.fatal.json'))
  const failed = await Promise.all(fatal.map(async name =>
    JSON.parse(await readFile(join(directory, name), 'utf8')) as AnalysisRun))
  return { runs: [...runs, ...failed] as AnalysisRun[], manifest, fatal }
}
const format = (number: number | null) => number === null ? 'unknown' : number.toFixed(2)

/** Zero to zero is unchanged; an increase from zero has no finite percentage. */
export function percentDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  if (a === 0) return b === 0 ? 0 : null
  return (b - a) / a * 100
}

export async function compare(dirA: string, dirB: string) {
  const [a, b] = await Promise.all([load(dirA), load(dirB)])
  const comparable = ['protocol', 'model', 'provider', 'fixtureHash', 'harnessHash', 'concurrency', 'timeoutMs', 'reps',
    'suite', 'seed', 'perTaskLimits', 'maxTotalTokens', 'maxTurns', 'maxToolCalls']
    .every(key => JSON.stringify(a.manifest[key]) === JSON.stringify(b.manifest[key]))
  const rows = []
  const arms = [...new Set([...a.runs, ...b.runs].map(run => run.arm))]
  const ids = [...new Set([...a.runs, ...b.runs].map(run => run.task)), 'ALL']
  for (const task of ids) for (const arm of arms) {
    const select = (runs: AnalysisRun[]) => runs.filter(run => run.arm === arm && (task === 'ALL' || run.task === task))
    const baseline = summarize(select(a.runs)), candidate = summarize(select(b.runs))
    const deltaPercent = Object.fromEntries((['score', 'tokens', 'leadCalls', 'wallMs', 'wastedLeadTurns'] as const)
      .map(key => [key, percentDelta(baseline[key].mean, candidate[key].mean)]))
    rows.push({ task, arm, a: baseline, b: candidate, deltaPercent })
  }
  const balanced = rows.every(row => row.a.n === row.b.n && row.a.n > 0)
  const summary = { balanced, schemaVersion: 1, dirA, dirB, comparable,
    synthetic: a.manifest.synthetic || b.manifest.synthetic,
    labels: { a: a.manifest.label, b: b.manifest.label },
    infrastructureErrors: { a: a.fatal, b: b.fatal }, rows }
  console.log('task / arm | N A/B | pass A/B | score A/B | tokens mean/median A:B | lead calls A/B | '
    + 'wall ms A/B | wasted A/B | delta % score/tokens/lead/wall/wasted (B vs A)')
  for (const row of rows) {
    console.log(`${row.task} / ${row.arm} | ${row.a.n}/${row.b.n} | `
      + `${format(row.a.passRate)}/${format(row.b.passRate)} | `
      + `${format(row.a.score.mean)}/${format(row.b.score.mean)} | `
      + `${format(row.a.tokens.mean)}/${format(row.a.tokens.median)}:`
      + `${format(row.b.tokens.mean)}/${format(row.b.tokens.median)} | `
      + `${format(row.a.leadCalls.mean)}/${format(row.b.leadCalls.mean)} | `
      + `${format(row.a.wallMs.mean)}/${format(row.b.wallMs.mean)} | `
      + `${format(row.a.wastedLeadTurns.mean)}/${format(row.b.wastedLeadTurns.mean)} | `
      + Object.values(row.deltaPercent).map(value =>
        value === null ? 'n/a' : `${value > 0 ? '+' : ''}${format(value)}%`).join('/'))
  }
  if (!comparable || !balanced) console.error('WARNING: configuration/sample mismatch; not a paired comparison.')
  if (a.fatal.length || b.fatal.length) console.error('WARNING: infrastructure failures; sample is incomplete.')
  await writeFile(join(dirB, 'comparison.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  return summary
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: analyze.ts <dirA> <dirB>')
  await compare(resolve(process.argv[2]), resolve(process.argv[3]))
}
