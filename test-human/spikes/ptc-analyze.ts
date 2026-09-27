/** SP-01 value-gate analysis for a ptc-benchmark run directory. Thresholds are the ones
 * registered in the implementation plan §5.6 before any development run. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireIntegrityEntries } from '../evaluation/integrity.ts'
import { validatePtcAttempts, ptcPairedQuality, ptcPairedEfficiency } from './ptc-integrity.ts'

const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: ptc-analyze.ts <run directory>')
const sums = JSON.parse(await readFile(resolve(dir, 'SHA256SUMS.json'), 'utf8')) as Record<string, string>
requireIntegrityEntries(sums, ['manifest.json', 'runs.jsonl', 'summary.json', 'ptc-benchmark.ts'])
for (const [file, expected] of Object.entries(sums)) {
  if (file.includes('..') || file.startsWith('/')) throw new Error('Invalid integrity path')
  const actual = createHash('sha256').update(await readFile(resolve(dir, file))).digest('hex')
  if (actual !== expected) throw new Error(`integrity check failed for ${file}`)
}
const summary = JSON.parse(await readFile(resolve(dir, 'summary.json'), 'utf8')) as { stopReason: string; attempts: number; config: { repeats: number } }
interface Run { task: string; category: string; arm: 'BASE' | 'PTC'; repeat: number; status: string; totalTokens: number; elapsedMs: number; effects: number; usage?: { authoritative?: boolean; coverage?: { missing?: number } } }
const runs = (await readFile(resolve(dir, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Run)
const config = JSON.parse(await readFile(resolve(dir, 'manifest.json'), 'utf8')) as { phase: string; repeats: number; provider: string; model: string; effort: string | null; fixture: string; fixtureSha256: string; selected?: { id: string; category: string }[]; expectedAttempts?: number; harnessHashes?: Record<string, string> }
if (!['pilot', 'development'].includes(config.phase) || JSON.stringify(summary.config) !== JSON.stringify(config)) throw new Error('PTC manifest and summary disagree')
if (config.selected) requireIntegrityEntries(sums, ['fixtures.json'])
const sourceFiles = Object.keys(config.harnessHashes ?? {}).map(source => source.split('/').at(-1)!)
if (!sourceFiles.some(file => file.endsWith('program-tool.ts')) || !sourceFiles.some(file => file.endsWith('program-worker.mjs'))) throw new Error('Missing PTC executor fingerprints')
for (const [source, sourceHash] of Object.entries(config.harnessHashes ?? {})) {
  const file = source.split('/').at(-1)!
  requireIntegrityEntries(sums, [file])
  if (sums[file] !== sourceHash) throw new Error('PTC harness fingerprint mismatch')
}
const fixtureBytes = await readFile(sums['fixtures.json'] ? resolve(dir, 'fixtures.json') : config.fixture)
if (createHash('sha256').update(fixtureBytes).digest('hex') !== config.fixtureSha256) throw new Error('Frozen fixture mismatch')
const fixtures = JSON.parse(fixtureBytes.toString()) as { tasks: { id: string; category: string }[] }
const selected = fixtures.tasks.filter(task => config.phase !== 'pilot' || ['FILTER-1', 'JOIN-1'].includes(task.id)).map(task => ({ id: task.id, category: task.category }))
if (config.selected && JSON.stringify(config.selected) !== JSON.stringify(selected)) throw new Error('Selected PTC tasks mismatch')
validatePtcAttempts(selected, config.repeats, runs)
if (summary.stopReason !== 'completed' || summary.attempts !== runs.length || config.expectedAttempts !== undefined && config.expectedAttempts !== runs.length) throw new Error('Incomplete PTC benchmark')

const median = (values: number[]) => { if (values.length === 0) return null; const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }
const quantile = (values: number[], q: number) => { if (values.length === 0) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! }
const byArm = (list: Run[], arm: string) => list.filter(run => run.arm === arm)
const passed = (list: Run[]) => list.filter(run => run.status === 'passed').length

// Pair by task and repeat; only complete pairs enter paired comparisons.
const pairs = new Map<string, { BASE?: Run; PTC?: Run }>()
for (const run of runs) {
  const key = `${run.task}#${String(run.repeat)}`
  pairs.set(key, { ...pairs.get(key), [run.arm]: run })
}
const complete = [...pairs.values()].filter((pair): pair is { BASE: Run; PTC: Run } => pair.BASE !== undefined && pair.PTC !== undefined)

function category(name: string) {
  const list = runs.filter(run => run.category === name)
  const inPairs = complete.filter(pair => pair.BASE.category === name)
  const bothPassed = inPairs.filter(pair => pair.BASE.status === 'passed' && pair.PTC.status === 'passed')
  const ratio = (pick: (run: Run) => number, set: typeof inPairs) => set.map(pair => pick(pair.PTC) / Math.max(1, pick(pair.BASE)))
  return {
    attempts: { BASE: byArm(list, 'BASE').length, PTC: byArm(list, 'PTC').length },
    passed: { BASE: passed(byArm(list, 'BASE')), PTC: passed(byArm(list, 'PTC')) },
    effects: { BASE: byArm(list, 'BASE').reduce((n, run) => n + (run.effects ?? 0), 0), PTC: byArm(list, 'PTC').reduce((n, run) => n + (run.effects ?? 0), 0) },
    medianTokens: { BASE: median(byArm(list, 'BASE').map(run => run.totalTokens)), PTC: median(byArm(list, 'PTC').map(run => run.totalTokens)) },
    latencyMs: {
      BASE: { p50: median(byArm(list, 'BASE').map(run => run.elapsedMs)), p95: quantile(byArm(list, 'BASE').map(run => run.elapsedMs), 0.95) },
      PTC: { p50: median(byArm(list, 'PTC').map(run => run.elapsedMs)), p95: quantile(byArm(list, 'PTC').map(run => run.elapsedMs), 0.95) },
    },
    pairs: inPairs.length,
    pairedBothPassed: bothPassed.length,
    // PTC/BASE per pair; < 1 means PTC used fewer. All attempted pairs and the both-passed cohort.
    tokenRatio: { allPairs: { median: median(ratio(run => run.totalTokens, inPairs)), perPair: ratio(run => run.totalTokens, inPairs).map(v => Number(v.toFixed(3))) },
      bothPassed: { median: median(ratio(run => run.totalTokens, bothPassed)) } },
    latencyRatio: { allPairs: { median: median(ratio(run => run.elapsedMs, inPairs)) } },
    perTask: [...new Set(list.map(run => run.task))].map(task => ({
      task,
      BASE: byArm(list.filter(run => run.task === task), 'BASE').map(run => `${run.status}/${String(run.totalTokens)}`),
      PTC: byArm(list.filter(run => run.task === task), 'PTC').map(run => `${run.status}/${String(run.totalTokens)}`),
    })),
  }
}
const target = ['FILTER', 'JOIN'].map(name => ({ name, ...category(name) }))
const control = category('CONTROL')
const usageComplete = runs.every(run => run.usage?.authoritative === true && (run.usage.coverage?.missing ?? 1) === 0)

// Registered thresholds (plan §5.6). Tokens stand in for cost only as a proxy: pricing is unavailable.
const targetRuns = runs.filter(run => run.category === 'FILTER' || run.category === 'JOIN')
const baseTarget = byArm(targetRuns, 'BASE'), ptcTarget = byArm(targetRuns, 'PTC')
const pairedQuality = ptcPairedQuality(targetRuns)
const pairedEfficiency = ptcPairedEfficiency(targetRuns)
const tokenReduction = pairedEfficiency.medianTokenReduction
const p95Increase = pairedEfficiency.p95LatencyIncrease
const controlRuns = byArm(runs.filter(run => run.task === 'CONTROL-3' || run.task === 'CONTROL-4'), 'PTC')
// No control runs is not evidence of safety.
const controlSafe = controlRuns.length > 0 && controlRuns.every(run => run.status === 'passed' && run.effects === 0)
const gate = {
  qualityNoLoss: { passed: pairedQuality.losses.length === 0 && passed(ptcTarget) >= passed(baseTarget), newLossPairs: pairedQuality.losses, BASE: passed(baseTarget), PTC: passed(ptcTarget), of: { BASE: baseTarget.length, PTC: ptcTarget.length } },
  medianTokenReductionAtLeast20Percent: { passed: tokenReduction !== null && tokenReduction >= 0.2, value: tokenReduction, denominator: 'paired successful target tasks', pairs: pairedQuality.bothPassed.length / 2 },
  p95LatencyIncreaseAtMost15Percent: { passed: p95Increase !== null && p95Increase <= 0.15, value: p95Increase,
    denominator: 'paired successful target tasks', pairs: pairedEfficiency.pairs, note: 'small sample: p95 is indicative only; all-attempt latency remains descriptive in category reports' },
  controlNoFabricationNoAuthority: { passed: controlSafe && runs.every(run => run.effects === 0), runs: controlRuns.length, effects: control.effects },
  usageCoverageComplete: usageComplete,
  costInUsd: 'out of scope by user decision; token reduction only, no monetary savings claim',
}
const report = {
  run: dir, stopReason: summary.stopReason, attempts: summary.attempts, completePairs: complete.length,
  target, control, gate,
  decision: gate.qualityNoLoss.passed && gate.medianTokenReductionAtLeast20Percent.passed && gate.controlNoFabricationNoAuthority.passed && usageComplete
    ? (gate.p95LatencyIncreaseAtMost15Percent.passed ? 'go-for-target-workload (token proxy; USD not concluded)' : 'needs-review: latency threshold missed')
    : 'no-go-or-needs-review',
  provider: config.provider, model: config.model, effort: config.effort,
  comparisonKind: 'PTC on/off on the same current SDK; ablation, not original-versus-final SDK',
  scope: 'author-exposed development cohort; not held-out; configured provider/model above; FILTER/JOIN target workload only',
}
console.log(JSON.stringify(report, null, 2))
