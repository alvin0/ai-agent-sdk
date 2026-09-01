#!/usr/bin/env node
import { HumanArtifactRecorder } from '../artifacts.ts'
import { errorMessage, label, paint } from '../console.ts'
import { parseSdkStressArgs, sdkStressHelp } from './config.ts'
import { runSdkStress, selectSdkStressScenarios } from './runner.ts'

async function main(): Promise<void> {
  let config
  try { config = parseSdkStressArgs(process.argv.slice(2)) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error(`\n${sdkStressHelp()}`)
    process.exitCode = 2
    return
  }
  if (config.help) { console.log(sdkStressHelp()); return }
  let scenarios
  try { scenarios = selectSdkStressScenarios(config) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    process.exitCode = 2
    return
  }
  const printable = {
    runId: config.runId, profile: config.profile, scenarios: scenarios.map(item => item.id),
    repeat: config.repeat, parallel: config.parallel, seed: config.seed,
    timeoutMs: config.timeoutMs, resultsRoot: config.resultsRoot,
  }
  console.log(label('sdk-stress/config'), JSON.stringify(printable, null, 2))
  if (config.dryRun) {
    const artifact = new HumanArtifactRecorder({
      harness: 'sdk-stress-plan', runId: config.runId, resultsRoot: config.resultsRoot,
    })
    artifact.record('plan', printable)
    const summary = await artifact.finish({
      status: 'dry-run', config: printable,
      invariants: [{ name: 'all selected scenario ids resolve', passed: true }],
      metrics: { scenarios: scenarios.length },
    })
    console.log(label('sdk-stress/artifact'), summary.artifact.directory)
    return
  }

  const controller = new AbortController()
  const interrupt = (): void => controller.abort(new Error('SDK stress interrupted by user'))
  process.once('SIGINT', interrupt)
  try {
    const summary = await runSdkStress(config, {
      signal: controller.signal,
      onProgress(event) {
        if (event.type === 'case-start') {
          if (config.verbose) console.log(label('sdk-stress/start'), event.caseId)
          return
        }
        const color = event.status === 'passed' ? 32 : event.status === 'aborted' ? 33 : 31
        console.log(label('sdk-stress/case'), paint(color, event.status ?? 'unknown'), event.caseId)
      },
    })
    console.log(label('sdk-stress/summary'), JSON.stringify({
      runId: summary.runId, profile: summary.profile,
      passed: summary.passed, failed: summary.failed, aborted: summary.aborted,
      totalIterations: summary.totalIterations, durationMs: summary.durationMs,
      resultsRoot: summary.resultsRoot,
    }, null, 2))
    if (summary.failed > 0 || summary.aborted > 0) process.exitCode = 1
  } catch (error: unknown) {
    console.error(label('sdk-stress/error'), paint(31, errorMessage(error)))
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}

await main()

