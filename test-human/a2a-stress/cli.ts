import type { A2AStressMode } from './config.ts'
import { a2aStressHelp, parseA2AStressArgs } from './config.ts'
import { DEFINED_STRESS_PROMPT, MANAGED_STRESS_PROMPT } from './prompts.ts'
import { runDefinedA2AStress, runManagedA2AStress } from './runner.ts'
import { errorMessage, label, paint } from '../console.ts'
import { HumanArtifactRecorder } from '../artifacts.ts'
import { a2aStressPaths } from './fixture.ts'

export async function runA2AStressCli(mode: A2AStressMode): Promise<void> {
  let config
  try { config = parseA2AStressArgs(mode, process.argv.slice(2)) }
  catch (error: unknown) {
    console.error(paint(31, errorMessage(error)))
    console.error(`\n${a2aStressHelp(mode)}`)
    process.exitCode = 2
    return
  }
  if (config.help) {
    console.log(a2aStressHelp(mode))
    return
  }
  const prompt = mode === 'managed' ? MANAGED_STRESS_PROMPT : DEFINED_STRESS_PROMPT
  console.log(label('config'), JSON.stringify(config, null, 2))
  console.log(label('prompt'), `\n${prompt}\n`)
  if (config.dryRun) {
    const paths = a2aStressPaths(config.runId, mode)
    const artifact = new HumanArtifactRecorder({
      harness: `a2a-${mode}-plan`, runId: 'plan', resultsRoot: paths.results,
    })
    artifact.record('plan', { mode, config, prompt })
    const summary = await artifact.finish({
      status: 'dry-run', config: { ...config, mode, prompt },
      invariants: [{ name: 'A2A stress plan is valid', passed: true }],
    })
    console.log(label('artifact'), summary.artifact.directory)
    return
  }

  const controller = new AbortController()
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const signal = AbortSignal.any([controller.signal, timeout])
  const interrupt = (): void => {
    controller.abort(new Error(`human interrupted A2A ${mode} stress run`))
    console.log(label('abort'), 'cancellation requested')
  }
  process.once('SIGINT', interrupt)
  try {
    const result = mode === 'managed'
      ? await runManagedA2AStress(config, signal)
      : await runDefinedA2AStress(config, signal)
    console.log(`\n${label('final')} ${result.finalText}`)
    console.log(label('workspace'), result.workspace)
    console.log(label('results'), result.results)
    for (const invariant of result.verification.invariants) {
      console.log(invariant.passed ? paint(32, '✓') : paint(31, '✗'), invariant.name,
        invariant.detail === undefined ? '' : `— ${invariant.detail}`)
    }
    if (!result.verification.passed) process.exitCode = 1
  } catch (error: unknown) {
    console.error(label('error'), paint(31, errorMessage(error)))
    process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', interrupt)
  }
}
