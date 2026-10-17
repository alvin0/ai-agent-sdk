import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { infraStatus } from './cells.ts'
import type { Result } from './execute.ts'
import type { Metrics } from './metrics.ts'

type AnalysisRun = Pick<Result, 'task' | 'arm' | 'score' | 'pass'>
  & { status: string; kind?: Result['kind']; metrics: Metrics | null; attempts?: Result['attempts'] }

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  if (!sorted.length) return null
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const incompleteUsage = (metrics: Metrics) => metrics.usageIncomplete || metrics.usageComplete === false
const distribution = (values: (number | null)[]) => {
  if (values.some(value => value === null)) return { mean: null, median: null }
  return { mean: mean(values as number[]), median: median(values as number[]) }
}

export function summarize(all: AnalysisRun[]) {
  const runs = all.filter(run => !infraStatus(run.status))
  const attempts = all.flatMap(run => run.attempts ?? [{ status: run.status, metrics: run.metrics }])
  return { infraFailedRuns: all.filter(run => infraStatus(run.status)).length,
    infraFailedAttempts: attempts.filter(attempt => infraStatus(attempt.status)).length,
    allAttemptsRetries: attempts.reduce((sum, attempt) => sum + (attempt.metrics?.modelRetries ?? 0), 0),
    allAttemptsRetryWaitMs: attempts.reduce((sum, attempt) => sum + (attempt.metrics?.retryWaitMs ?? 0), 0),
    ...summaryMetrics(runs) }
}
function delegationSummary(runs: AnalysisRun[]) {
  const team = runs.filter(run => run.arm !== 'single')
  const delegated = (run: AnalysisRun): boolean | undefined => run.metrics?.delegated
    ?? (typeof run.metrics?.spawns === 'number' ? run.metrics.spawns > 0 : undefined)
  const selected = (value: boolean) => team.filter(run => delegated(run) === value)
  const score = (group: AnalysisRun[]) => ({ n: group.length, score: distribution(group.map(run => run.score)) })
  const known = team.filter(run => delegated(run) !== undefined)
  const rate = known.length === team.length ? mean(known.map(run => Number(delegated(run)))) : null
  return { delegationRate: rate,
    delegationUnknownRuns: team.length - known.length,
    delegated: score(selected(true)), nonDelegated: score(selected(false)) }
}
function summaryMetrics(runs: AnalysisRun[]) {
  return { ...delegationSummary(runs), passedRuns: runs.filter(run => run.pass).length,
    scoreSum: runs.reduce((sum, run) => sum + run.score, 0), n: runs.length,
    passRate: mean(runs.map(run => Number(run.pass))),
    score: distribution(runs.map(run => run.score)),
    tokens: distribution(runs.map(run => run.metrics?.totalTokens ?? run.metrics?.reportedTokens ?? null)),
    tokenLowerBoundRuns: runs.filter(run => run.metrics && (incompleteUsage(run.metrics)
      || run.metrics.totalTokens === null)).length,
    costWeightedTokens: distribution(runs.map(run => run.metrics?.costWeightedTokens
      ?? run.metrics?.reportedCostWeightedTokens ?? null)),
    weightedLowerBoundRuns: runs.filter(run => run.metrics && (incompleteUsage(run.metrics)
      || run.metrics.costWeightedTokens === null)).length,
    uncachedInput: distribution(runs.map(run => run.metrics?.uncachedInputTokens ?? null)),
    cachedInput: distribution(runs.map(run => run.metrics?.cachedInputTokens ?? null)),
    output: distribution(runs.map(run => run.metrics?.outputTokens ?? null)),
    leadCalls: distribution(runs.map(run => run.metrics?.leadModelCalls ?? null)),
    totalCalls: distribution(runs.map(run => run.metrics?.totalModelCalls ?? null)),
    retries: distribution(runs.map(run => run.metrics?.modelRetries ?? null)),
    retryWaitMs: distribution(runs.map(run => run.metrics?.retryWaitMs ?? null)),
    wallActiveMs: distribution(runs.map(run => run.metrics?.wallActiveMs ?? null)),
    wallMs: distribution(runs.map(run => run.metrics?.wallMs ?? null)),
    spawns: distribution(runs.map(run => run.metrics?.spawns ?? null)),
    wastedLeadTurns: distribution(runs.map(run => run.metrics?.wastedLeadTurns ?? null)),
    errors: runs.reduce((sum, run) => sum + (run.metrics?.errors.length ?? 1), 0),
    capHits: Object.fromEntries(['tokens', 'turns', 'toolCalls'].map(cap => [cap,
      runs.filter(run => run.metrics?.capHits?.[cap as keyof Metrics['capHits']]).length])),
    usageIncompleteRuns: runs.filter(run => run.metrics && incompleteUsage(run.metrics)).length,
    completedOrphanRuns: runs.filter(run => run.status === 'completed-orphans').length,
    orphanWorkers: runs.reduce((sum, run) => sum + (run.metrics?.orphanWorkers ?? 0), 0),
    orphanWorkersAfterGrace: runs.reduce((sum, run) => sum + (run.metrics?.orphanWorkersAfterGrace ?? 0), 0),
    timeouts: runs.filter(run => run.status === 'timeout').length }
}

async function load(directory: string) {
  const names = (await readdir(directory)).filter(name => /\.(single|team|collab)\.\d+\.json$/.test(name))
  const runs = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const fatal = (await readdir(directory)).filter(name => name.endsWith('.fatal.json')
    && !names.includes(name.replace('.fatal.json', '.json')))
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

type Summary = ReturnType<typeof summarize>
type ComparisonRow = { task: string; arm: string; a: Summary; b: Summary;
  deltaPercent: Record<string, number | null> }
function printRows(rows: ComparisonRow[]) {
  console.log('task / arm | N A/B | pass A/B | score A/B | tokens mean/median A:B | lead calls A/B | '
    + 'delegation rate A/B | delegated score A/B | non-delegated score A/B | '
    + 'weighted A/B | uncached A/B | cached A/B | output A/B | lower-bound runs raw/weighted A:B | '
    + 'infra runs/attempts A:B | retries A/B | retry wait ms A/B | active wall ms A/B | '
    + 'orphan runs/workers A:B | incomplete usage A/B | wall ms A/B | wasted A/B | '
    + 'delta % score/raw/weighted/lead/wall/active/wasted (B vs A)')
  for (const row of rows) {
    console.log(`${row.task} / ${row.arm} | ${row.a.n}/${row.b.n} | `
      + `${format(row.a.passRate)}/${format(row.b.passRate)} | `
      + `${format(row.a.score.mean)}/${format(row.b.score.mean)} | `
      + `${format(row.a.tokens.mean)}/${format(row.a.tokens.median)}:`
      + `${format(row.b.tokens.mean)}/${format(row.b.tokens.median)} | `
      + `${format(row.a.leadCalls.mean)}/${format(row.b.leadCalls.mean)} | `
      + `${format(row.a.delegationRate)}/${format(row.b.delegationRate)} | `
      + `${format(row.a.delegated.score.mean)}/${format(row.b.delegated.score.mean)} | `
      + `${format(row.a.nonDelegated.score.mean)}/${format(row.b.nonDelegated.score.mean)} | `
      + `${format(row.a.costWeightedTokens.mean)}/${format(row.b.costWeightedTokens.mean)} | `
      + `${format(row.a.uncachedInput.mean)}/${format(row.b.uncachedInput.mean)} | `
      + `${format(row.a.cachedInput.mean)}/${format(row.b.cachedInput.mean)} | `
      + `${format(row.a.output.mean)}/${format(row.b.output.mean)} | `
      + `${row.a.tokenLowerBoundRuns}/${row.a.weightedLowerBoundRuns}:`
      + `${row.b.tokenLowerBoundRuns}/${row.b.weightedLowerBoundRuns} | `
      + `${row.a.infraFailedRuns}/${row.a.infraFailedAttempts}:${row.b.infraFailedRuns}/${row.b.infraFailedAttempts} | `
      + `${format(row.a.retries.mean)}/${format(row.b.retries.mean)} | `
      + `${format(row.a.retryWaitMs.mean)}/${format(row.b.retryWaitMs.mean)} | `
      + `${format(row.a.wallActiveMs.mean)}/${format(row.b.wallActiveMs.mean)} | `
      + `${row.a.completedOrphanRuns}/${row.a.orphanWorkers}:${row.b.completedOrphanRuns}/${row.b.orphanWorkers} | `
      + `${row.a.usageIncompleteRuns}/${row.b.usageIncompleteRuns} | `
      + `${format(row.a.wallMs.mean)}/${format(row.b.wallMs.mean)} | `
      + `${format(row.a.wastedLeadTurns.mean)}/${format(row.b.wastedLeadTurns.mean)} | `
      + Object.values(row.deltaPercent).map(value =>
        value === null ? 'n/a' : `${value > 0 ? '+' : ''}${format(value)}%`).join('/'))
  }
}


/** Equivalent lost full-score runs plus strict pass losses; unequal cohorts cannot establish this gate. */
export function mergeGateDelta(row: ComparisonRow) {
  const matched = row.a.n === row.b.n && row.a.n > 0
  const scoreRunDelta = matched ? row.b.scoreSum - row.a.scoreSum : null
  const passRunDelta = matched ? row.b.passedRuns - row.a.passedRuns : null
  const scoreDelta = absoluteDelta(row.a.score.mean, row.b.score.mean)
  return { task: row.task, arm: row.arm, nA: row.a.n, nB: row.b.n, scoreDelta,
    deltaPercent: { score: row.deltaPercent.score ?? null,
      weightedTokens: row.deltaPercent.costWeightedTokens ?? null,
      leadCalls: row.deltaPercent.leadCalls ?? null, wall: row.deltaPercent.wallMs ?? null },
    scoreRunDelta, passRunDelta,
    regressionMoreThanOneRun: matched ? scoreRunDelta! < -1 - 1e-9 || passRunDelta! < -1 : null }
}
function absoluteDelta(a: number | null, b: number | null) {
  return a === null || b === null ? null : b - a
}
function regressionLabel(value: boolean | null) {
  if (value === null) return 'unknown'
  return value ? 'REGRESSION' : 'no'
}
function printMergeGate(rows: ReturnType<typeof mergeGateDelta>[]) {
  console.log('Merge-gate deltas (B vs A; live matched N>=3 and review still required)')
  console.log('task / arm | score delta | delta % score/weighted/lead/wall | score/pass run delta | regression >1 run')
  for (const row of rows) {
    console.log(`${row.task} / ${row.arm} | ${format(row.scoreDelta)} | `
      + Object.values(row.deltaPercent).map(value => value === null ? 'n/a' : `${format(value)}%`).join('/')
      + ` | ${format(row.scoreRunDelta)}/${format(row.passRunDelta)} | `
      + regressionLabel(row.regressionMoreThanOneRun))
  }
}

function insufficient(rows: ComparisonRow[], tasks: string[], repsA: number, repsB: number) {
  return rows.filter(row => tasks.includes(row.task)).flatMap(row =>
    (['a', 'b'] as const).flatMap(side => {
      const requested = side === 'a' ? repsA : repsB
      return row[side].n < requested ? [{ side, task: row.task, arm: row.arm, n: row[side].n, requested }] : []
    }))
}

function dimensions(a: Awaited<ReturnType<typeof load>>, b: Awaited<ReturnType<typeof load>>) {
  const arms = [...new Set([...(a.manifest.arms as string[] ?? []), ...(b.manifest.arms as string[] ?? []),
    ...[...a.runs, ...b.runs].map(run => run.arm)])]
  const kinds = [...new Set([...a.runs, ...b.runs].flatMap(run => run.kind ? [run.kind] : []))]
  const taskIds = [...new Set([...(a.manifest.ids as string[] ?? []), ...(b.manifest.ids as string[] ?? []),
    ...[...a.runs, ...b.runs].map(run => run.task)])]
  const ids = [...taskIds,
    ...kinds.map(kind => `kind:${kind}`), 'ALL']
  return { arms, taskIds, ids }
}

function manifestTeamOptions(manifest: Record<string, unknown>) { return manifest.teamOptions ?? {} }

export async function compare(dirA: string, dirB: string, out?: string) {
  const [a, b] = await Promise.all([load(dirA), load(dirB)])
  const comparable = ['protocol', 'model', 'provider', 'fixtureHash', 'harnessHash', 'concurrency', 'timeoutMs', 'reps',
    'suite', 'seed', 'tokenAccounting', 'perTaskTimeouts', 'perTaskOutputBudget', 'perTaskLimits',
    'maxTotalTokens', 'maxTurns', 'maxToolCalls', 'maxInflightModelCalls', 'retryPolicy', 'maxRunAttempts']
    .every(key => JSON.stringify(a.manifest[key]) === JSON.stringify(b.manifest[key]))
  const rows = []
  const { arms, taskIds, ids } = dimensions(a, b)
  for (const task of ids) for (const arm of arms) {
    const select = (runs: AnalysisRun[]) => runs.filter(run => run.arm === arm
      && (task === 'ALL' || run.task === task || `kind:${run.kind}` === task))
    const baseline = summarize(select(a.runs)), candidate = summarize(select(b.runs))
    const deltaKeys = ['score', 'tokens', 'costWeightedTokens', 'leadCalls',
      'wallMs', 'wallActiveMs', 'wastedLeadTurns'] as const
    const deltaPercent = Object.fromEntries(deltaKeys
      .map(key => [key, percentDelta(baseline[key].mean, candidate[key].mean)]))
    rows.push({ task, arm, a: baseline, b: candidate, deltaPercent })
  }
  const balanced = rows.every(row => row.a.n === row.b.n && row.a.n > 0)
  const insufficientCells = insufficient(rows, taskIds, Number(a.manifest.reps), Number(b.manifest.reps))
  const mergeGate = rows.filter(row => taskIds.includes(row.task) && row.a.n > 0 && row.b.n > 0).map(mergeGateDelta)
  const summary = { mergeGate, insufficientCells, balanced, schemaVersion: 1, dirA, dirB, comparable,
    synthetic: a.manifest.synthetic || b.manifest.synthetic,
    labels: { a: a.manifest.label, b: b.manifest.label },
    teamOptions: { a: manifestTeamOptions(a.manifest), b: manifestTeamOptions(b.manifest) },
    infrastructureErrors: { a: a.fatal, b: b.fatal }, rows }
  printRows(rows)
  printMergeGate(mergeGate)
  if (!comparable || !balanced) console.error('WARNING: configuration/sample mismatch; not a paired comparison.')
  for (const cell of insufficientCells) {
    console.error(`WARNING: ${cell.side} ${cell.task}/${cell.arm} N=${cell.n} < requested reps=${cell.requested}`)
  }
  if (rows.some(row => row.a.infraFailedAttempts || row.b.infraFailedAttempts)) {
    console.error('WARNING: infrastructure failures recorded; inspect attempt counts and cell coverage.')
  }
  if (rows.some(row => row.a.tokenLowerBoundRuns || row.b.tokenLowerBoundRuns)) {
    console.error('WARNING: token totals include reported lower bounds; cost deltas are not exact.')
  }
  if (out !== undefined) await writeFile(out, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
  return summary
}
function validOutputArgs(rest: string[]) {
  if (rest.length === 0) return true
  return rest.length === 2 && rest[0] === '--out' && Boolean(rest[1]) && !rest[1]!.startsWith('--')
}
export function parseAnalysisArgs(args: string[]) {
  const [dirA, dirB, ...rest] = args
  if (!dirA || !dirB || dirA.startsWith('--') || dirB.startsWith('--')
    || !validOutputArgs(rest)) {
    throw new Error('Usage: analyze.ts <dirA> <dirB> [--out <file>]')
  }
  return { dirA: resolve(dirA), dirB: resolve(dirB), out: rest[1] === undefined ? undefined : resolve(rest[1]) }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { dirA, dirB, out } = parseAnalysisArgs(process.argv.slice(2))
  await compare(dirA, dirB, out)
}
