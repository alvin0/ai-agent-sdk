#!/usr/bin/env node
import { join } from 'node:path'
import { errorMessage, label, paint } from '../console.ts'
import { HumanArtifactRecorder } from '../artifacts.ts'
import { parseSkillStressArgs, skillStressHelp } from './config.ts'
import { runSkillStress, selectStressScenarios } from './runner.ts'
import type { StressProgressEvent } from './types.ts'

async function main(): Promise<void> {
  let config
  try {
    config = parseSkillStressArgs(process.argv.slice(2))
  } catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error('\n' + skillStressHelp())
    process.exitCode = 2
    return
  }
  if (config.help) { console.log(skillStressHelp()); return }
  let scenarios
  try { scenarios = selectStressScenarios(config) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    process.exitCode = 2
    return
  }
  console.log(label('skill-stress/config'), JSON.stringify({
    runId: config.runId, suite: config.suite,
    scenarios: scenarios.map(scenario => scenario.id),
    parallel: config.parallel, repeat: config.repeat, seed: config.seed,
    provider: config.provider, model: config.model, effort: config.effort,
    skillsRoot: config.skillsRoot, workspaceRoot: config.workspaceRoot,
    resultsRoot: config.resultsRoot, timeoutMs: config.timeoutMs,
  }, null, 2))
  if (config.dryRun) {
    const artifact = new HumanArtifactRecorder({
      harness: 'skill-stress-plan', runId: 'plan', resultsRoot: join(config.resultsRoot, config.runId),
    })
    const selected = scenarios.map(scenario => scenario.id)
    artifact.record('plan', { suite: config.suite, scenarios: selected, repeat: config.repeat, seed: config.seed })
    const summary = await artifact.finish({
      status: 'dry-run', config: { ...config },
      invariants: [{ name: 'all selected skill stress scenarios resolve', passed: true }],
      metrics: { scenarios: selected.length, plannedCases: selected.length * config.repeat },
    })
    console.log(label('skill-stress/artifact'), summary.artifact.directory)
    return
  }

  const controller = new AbortController()
  const interrupt = (): void => {
    if (!controller.signal.aborted) {
      console.error('\n' + label('skill-stress/abort'), 'stopping active cases at safe cancellation boundaries')
      controller.abort(new Error('skill stress interrupted by the user'))
    }
  }
  process.on('SIGINT', interrupt)
  try {
    const summary = await runSkillStress(config, {
      signal: controller.signal,
      onProgress: event => renderProgress(event, config.verboseEvents),
    })
    console.log(label('skill-stress/summary'), JSON.stringify({
      runId: summary.runId,
      passed: summary.passed, failed: summary.failed, aborted: summary.aborted,
      durationMs: summary.durationMs, resultsRoot: summary.resultsRoot,
    }, null, 2))
    for (const result of summary.cases.filter(item => item.status !== 'passed')) {
      console.error(label(`skill-stress/${result.status}`), result.caseId)
      for (const invariant of result.invariants.filter(item => !item.passed)) {
        console.error(`  - ${invariant.name}${invariant.detail === undefined ? '' : `: ${invariant.detail}`}`)
      }
    }
    if (summary.failed > 0 || summary.aborted > 0) process.exitCode = 1
  } catch (error: unknown) {
    console.error(label('skill-stress/error'), paint(31, errorMessage(error)))
    process.exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
  }
}

function renderProgress(event: StressProgressEvent, verbose: boolean): void {
  if (event.type === 'case-start') {
    if (verbose) console.log(label('skill-stress/start'), event.caseId)
    return
  }
  const color = event.status === 'passed' ? 32 : event.status === 'aborted' ? 33 : 31
  console.log(label('skill-stress/case'), paint(color, event.status ?? 'unknown'), event.caseId)
}

await main()
