import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { skillStressScenarios } from './scenarios/index.ts'
import type {
  SkillStressConfig,
  StressCaseContext,
  StressCasePaths,
  StressCaseResult,
  StressProgressEvent,
  StressRunSummary,
  StressScenario,
} from './types.ts'

export interface RunSkillStressOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (event: StressProgressEvent) => void
}

interface PlannedCase {
  readonly scenario: StressScenario
  readonly repeat: number
  readonly seed: number
  readonly caseId: string
}

export function selectStressScenarios(config: SkillStressConfig): readonly StressScenario[] {
  const all = skillStressScenarios()
  const bySuite = all.filter(scenario => config.suite === 'all' || scenario.kind === config.suite)
  if (config.scenarioIds.length === 0) return Object.freeze(bySuite)
  const known = new Set(all.map(scenario => scenario.id))
  const unknown = config.scenarioIds.filter(id => !known.has(id))
  if (unknown.length > 0) throw new Error(`unknown stress scenario(s): ${unknown.join(', ')}`)
  const requested = new Set(config.scenarioIds)
  const selected = bySuite.filter(scenario => requested.has(scenario.id))
  if (selected.length !== requested.size) {
    throw new Error(`selected scenario does not belong to suite '${config.suite}'`)
  }
  return Object.freeze(selected)
}

export async function runSkillStress(
  config: SkillStressConfig,
  options: RunSkillStressOptions = {},
): Promise<StressRunSummary> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const scenarios = selectStressScenarios(config)
  if (scenarios.length === 0) throw new Error(`suite '${config.suite}' selected no scenarios`)
  const runResults = join(config.resultsRoot, config.runId)
  const runWorkspaces = join(config.workspaceRoot, config.runId)
  await Promise.all([
    mkdir(runResults, { recursive: true }),
    mkdir(runWorkspaces, { recursive: true }),
  ])
  const planned = planCases(scenarios, config)
  const results: StressCaseResult[] = []
  let cursor = 0
  let stop = false
  const rootSignal = options.signal ?? new AbortController().signal
  const workers = Array.from({ length: Math.min(config.parallel, planned.length) }, async () => {
    while (!stop && !rootSignal.aborted) {
      const index = cursor++
      const plannedCase = planned[index]
      if (plannedCase === undefined) return
      options.onProgress?.({
        type: 'case-start', caseId: plannedCase.caseId, scenarioId: plannedCase.scenario.id,
      })
      const result = await runOne(config, plannedCase, runWorkspaces, runResults, rootSignal)
      results.push(result)
      options.onProgress?.({
        type: 'case-end', caseId: result.caseId, scenarioId: result.scenarioId, status: result.status,
      })
      if (config.failFast && result.status !== 'passed') stop = true
    }
  })
  await Promise.all(workers)
  results.sort((left, right) => left.caseId.localeCompare(right.caseId))
  const finished = Date.now()
  const summary: StressRunSummary = Object.freeze({
    runId: config.runId,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    aborted: results.filter(result => result.status === 'aborted').length,
    resultsRoot: runResults,
    cases: Object.freeze(results),
  })
  await writeFile(join(runResults, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return summary
}

function planCases(
  scenarios: readonly StressScenario[],
  config: SkillStressConfig,
): readonly PlannedCase[] {
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

async function runOne(
  config: SkillStressConfig,
  planned: PlannedCase,
  runWorkspaces: string,
  runResults: string,
  rootSignal: AbortSignal,
): Promise<StressCaseResult> {
  const started = Date.now()
  const paths: StressCasePaths = Object.freeze({
    root: join(runWorkspaces, planned.caseId),
    workspace: join(runWorkspaces, planned.caseId, 'workspace'),
    skills: join(runWorkspaces, planned.caseId, 'skills'),
    report: join(runResults, planned.caseId),
  })
  await Promise.all([
    mkdir(paths.workspace, { recursive: true }),
    mkdir(paths.skills, { recursive: true }),
    mkdir(paths.report, { recursive: true }),
  ])
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = AbortSignal.any([rootSignal, timeout])
  const context: StressCaseContext = Object.freeze({
    config, caseId: planned.caseId, repeat: planned.repeat, seed: planned.seed, paths, signal,
  })
  let result: StressCaseResult
  try {
    signal.throwIfAborted()
    const scenarioResult = await planned.scenario.run(context)
    const passed = scenarioResult.invariants.every(invariant => invariant.passed)
    const finished = Date.now()
    result = Object.freeze({
      caseId: planned.caseId, scenarioId: planned.scenario.id, kind: planned.scenario.kind,
      repeat: planned.repeat, seed: planned.seed,
      status: passed ? 'passed' : 'failed',
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started, paths,
      invariants: scenarioResult.invariants,
      ...(scenarioResult.metrics === undefined ? {} : { metrics: scenarioResult.metrics }),
    })
  } catch (error: unknown) {
    const finished = Date.now()
    const aborted = signal.aborted || isAbortError(error)
    const message = errorMessage(signal.aborted ? signal.reason ?? error : error)
    result = Object.freeze({
      caseId: planned.caseId, scenarioId: planned.scenario.id, kind: planned.scenario.kind,
      repeat: planned.repeat, seed: planned.seed,
      status: aborted ? 'aborted' : 'failed',
      startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started, paths,
      invariants: Object.freeze([{
        name: 'scenario completes without an unhandled runtime error', passed: false, detail: message,
      }]),
      error: message,
    })
  }
  await writeFile(join(paths.report, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  if (result.status === 'passed' && !config.keepWorkspaces) await removeGeneratedCase(runWorkspaces, paths.root)
  return result
}

async function removeGeneratedCase(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  const fromRoot = relative(absoluteRoot, absoluteTarget)
  if (fromRoot.length === 0 || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`refusing to remove stress path outside the run root: ${absoluteTarget}`)
  }
  await rm(absoluteTarget, { recursive: true, force: true })
}

function derivedSeed(base: number, id: string, repeat: number): number {
  let hash = (base ^ repeat) >>> 0
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
