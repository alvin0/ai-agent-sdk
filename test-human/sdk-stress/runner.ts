import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HumanArtifactRecorder } from '../artifacts.ts'
import { profileIterations } from './config.ts'
import { sdkStressScenarios } from './scenarios/index.ts'
import type {
  SdkStressCaseResult,
  SdkStressConfig,
  SdkStressScenario,
  SdkStressSummary,
} from './types.ts'

export interface RunSdkStressOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (event: {
    readonly type: 'case-start' | 'case-end'
    readonly caseId: string
    readonly status?: SdkStressCaseResult['status']
  }) => void
}

interface PlannedCase {
  readonly scenario: SdkStressScenario
  readonly repeat: number
  readonly seed: number
  readonly caseId: string
}

export function selectSdkStressScenarios(config: SdkStressConfig): readonly SdkStressScenario[] {
  const all = sdkStressScenarios()
  if (config.scenarioIds.length === 0) return all
  const known = new Set(all.map(scenario => scenario.id))
  const unknown = config.scenarioIds.filter(id => !known.has(id))
  if (unknown.length > 0) throw new Error(`unknown sdk stress scenario(s): ${unknown.join(', ')}`)
  const requested = new Set(config.scenarioIds)
  return Object.freeze(all.filter(scenario => requested.has(scenario.id)))
}

export async function runSdkStress(
  config: SdkStressConfig,
  options: RunSdkStressOptions = {},
): Promise<SdkStressSummary> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const root = join(config.resultsRoot, config.runId)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const scenarios = selectSdkStressScenarios(config)
  if (scenarios.length === 0) throw new Error('sdk stress selected no scenarios')
  const planned = planCases(scenarios, config)
  const results: SdkStressCaseResult[] = []
  const signal = options.signal ?? new AbortController().signal
  let cursor = 0
  let stopped = false
  const workers = Array.from({ length: Math.min(config.parallel, planned.length) }, async () => {
    while (!stopped && !signal.aborted) {
      const plannedCase = planned[cursor++]
      if (plannedCase === undefined) return
      options.onProgress?.({ type: 'case-start', caseId: plannedCase.caseId })
      const result = await runCase(config, root, plannedCase, signal)
      results.push(result)
      options.onProgress?.({ type: 'case-end', caseId: result.caseId, status: result.status })
      if (config.failFast && result.status !== 'passed') stopped = true
    }
  })
  await Promise.all(workers)
  results.sort((left, right) => left.caseId.localeCompare(right.caseId))
  const finished = Date.now()
  const summary: SdkStressSummary = Object.freeze({
    schemaVersion: 1,
    runId: config.runId,
    profile: config.profile,
    seed: config.seed,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    aborted: results.filter(result => result.status === 'aborted').length,
    totalIterations: results.reduce((total, result) => total + result.iterations, 0),
    resultsRoot: root,
    cases: Object.freeze(results),
  })
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  })
  return summary
}

function planCases(scenarios: readonly SdkStressScenario[], config: SdkStressConfig): readonly PlannedCase[] {
  const output: PlannedCase[] = []
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= config.repeat; repeat++) {
      const seed = derivedSeed(config.seed, scenario.id, repeat)
      output.push(Object.freeze({
        scenario, repeat, seed,
        caseId: `${scenario.id}-r${repeat}-${seed.toString(16).padStart(8, '0')}`,
      }))
    }
  }
  return Object.freeze(output)
}

async function runCase(
  config: SdkStressConfig,
  runRoot: string,
  planned: PlannedCase,
  rootSignal: AbortSignal,
): Promise<SdkStressCaseResult> {
  const started = Date.now()
  const iterations = Math.max(1, Math.round(profileIterations(config.profile) * (planned.scenario.weight ?? 1)))
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = AbortSignal.any([rootSignal, timeout])
  const artifact = new HumanArtifactRecorder({
    harness: 'sdk-stress-case', runId: planned.caseId, resultsRoot: runRoot,
  })
  artifact.record('case-start', {
    scenario: planned.scenario.id, description: planned.scenario.description,
    repeat: planned.repeat, seed: planned.seed, iterations, profile: config.profile,
  })
  try {
    signal.throwIfAborted()
    const result = await planned.scenario.run(Object.freeze({
      config, caseId: planned.caseId, repeat: planned.repeat, seed: planned.seed,
      iterations, signal, artifact, random: mulberry32(planned.seed),
    }))
    const passed = result.invariants.every(invariant => invariant.passed)
    await artifact.finish({
      status: passed ? 'passed' : 'failed',
      config: { profile: config.profile, scenario: planned.scenario.id, repeat: planned.repeat, seed: planned.seed },
      invariants: result.invariants,
      metrics: result.metrics,
    })
    return Object.freeze({
      caseId: planned.caseId, scenarioId: planned.scenario.id,
      repeat: planned.repeat, seed: planned.seed, iterations,
      status: passed ? 'passed' : 'failed', durationMs: Date.now() - started,
      artifact: artifact.summaryPath,
      invariants: result.invariants, metrics: result.metrics,
    })
  } catch (error: unknown) {
    const aborted = signal.aborted || isAbortError(error)
    const message = errorMessage(signal.aborted ? signal.reason ?? error : error)
    const invariants = Object.freeze([{
      name: 'scenario completes without an unhandled runtime error', passed: false, detail: message,
    }])
    await artifact.finish({ status: aborted ? 'aborted' : 'failed', invariants, error })
    return Object.freeze({
      caseId: planned.caseId, scenarioId: planned.scenario.id,
      repeat: planned.repeat, seed: planned.seed, iterations,
      status: aborted ? 'aborted' : 'failed', durationMs: Date.now() - started,
      artifact: artifact.summaryPath, invariants, error: message,
    })
  }
}

function derivedSeed(base: number, id: string, repeat: number): number {
  let hash = (base ^ repeat) >>> 0
  for (const character of id) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
