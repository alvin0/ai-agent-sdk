#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stripCommandSeparators } from '../../cli-args.ts'
import {
  fallbackRunId, readOption, researchFallbackReason, setOption, type AcceptanceSummary,
} from './recovery.ts'

const DEFAULT_MODEL = 'gpt-5.6-luna'
const DEFAULT_FALLBACK_MODEL = 'gpt-5.6-luna'
const DEFAULT_RESULTS_ROOT = 'test-human/results/edge-chat-live'

await main()

async function main(): Promise<void> {
  const raw = stripCommandSeparators(process.argv.slice(2))
  const fallbackModel = readOption(raw, '--fallback-model') ?? DEFAULT_FALLBACK_MODEL
  const fallbackDisabled = raw.includes('--no-search-fallback')
  const resumedRunId = readOption(raw, '--resume-primary-run')
  const forwarded = removeRecoveryOptions(raw)
  const runId = resumedRunId ?? readOption(forwarded, '--run-id')
    ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new TypeError('run id is invalid')
  const primaryModel = readOption(forwarded, '--model') ?? DEFAULT_MODEL
  const resultsRoot = resolve(readOption(forwarded, '--results-root') ?? DEFAULT_RESULTS_ROOT)
  const primaryArgs = setOption(forwarded, '--run-id', runId)
  const primaryExit = resumedRunId === undefined ? await runSingle(primaryArgs) : 1
  const primarySummary = await readSummary(resultsRoot, runId)
  const trigger = researchFallbackReason(primarySummary)
  if (primaryExit === 0 || fallbackDisabled || primaryModel === fallbackModel
    || trigger === undefined) {
    process.exitCode = primaryExit
    return
  }

  const recoveredRunId = fallbackRunId(runId, fallbackModel)
  const fallbackArgs = setOption(setOption(primaryArgs, '--run-id', recoveredRunId), '--model', fallbackModel)
  process.stdout.write(
    `Native search acceptance failed for ${primaryModel}; retrying with fallback model ${fallbackModel}.\n`,
  )
  const fallbackExit = await runSingle(fallbackArgs)
  const fallbackSummary = await readSummary(resultsRoot, recoveredRunId)
  const status = fallbackExit === 0 && fallbackSummary.status === 'passed' ? 'recovered' : 'failed'
  const recoveryDirectory = join(resultsRoot, `${runId}-recovery`)
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
  const combined = {
    schemaVersion: 1, harness: 'edge-chat-live-search-recovery', status, trigger,
    searchStrategy: {
      primary: 'selected-model-provider-native-search',
      fallback: 'alternate-model-provider-native-search',
      selectedResult: status === 'recovered' ? 'fallback' : 'none',
    },
    primary: { model: primaryModel, runId, exitCode: primaryExit,
      summary: join(resultsRoot, runId, 'summary.json') },
    fallback: { model: fallbackModel, runId: recoveredRunId, exitCode: fallbackExit,
      summary: join(resultsRoot, recoveredRunId, 'summary.json') },
  }
  const summaryPath = join(recoveryDirectory, 'summary.json')
  await writeFile(summaryPath, `${JSON.stringify(combined, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(`Edge live search recovery ${status}: ${summaryPath}\n`)
  process.exitCode = status === 'recovered' ? 0 : 1
}

function removeRecoveryOptions(args: readonly string[]): readonly string[] {
  const output: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--fallback-model') { index++; continue }
    if (args[index] === '--resume-primary-run') { index++; continue }
    if (args[index] === '--no-search-fallback') continue
    output.push(args[index]!)
  }
  return output
}

async function runSingle(args: readonly string[]): Promise<number> {
  const singleRunner = resolve('test-human/edge-chat/live/cli.ts')
  const child = spawn(process.execPath, ['--experimental-strip-types', singleRunner, '--', ...args], {
    cwd: process.cwd(), stdio: 'inherit', env: process.env,
  })
  return await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? (signal === null ? 1 : 128)))
  })
}

async function readSummary(resultsRoot: string, runId: string): Promise<AcceptanceSummary> {
  const path = join(resultsRoot, runId, 'summary.json')
  return JSON.parse(await readFile(path, 'utf8')) as AcceptanceSummary
}
