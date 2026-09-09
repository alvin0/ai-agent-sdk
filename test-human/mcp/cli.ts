#!/usr/bin/env node

import { resolve } from 'node:path'
import { HumanArtifactRecorder } from '../artifacts.ts'
import { stripCommandSeparators } from '../cli-args.ts'
import { runMcpRoundTrips } from './runner.ts'

const args = parseArgs(process.argv.slice(2))
const artifact = new HumanArtifactRecorder({
  harness: 'mcp-roundtrip', resultsRoot: args.resultsRoot,
  ...(args.runId === undefined ? {} : { runId: args.runId }),
})
const config = { requests: args.requests, parallel: args.parallel, cycles: args.cycles }
artifact.record('config', config)

if (args.dryRun) {
  const summary = await artifact.finish({
    status: 'dry-run', config,
    invariants: [{ name: 'MCP workload configuration is valid', passed: true }],
  })
  console.log(JSON.stringify({ status: 'dry-run', config, artifact: summary.artifact.directory }, null, 2))
} else {
  try {
    const result = await runMcpRoundTrips({
      ...config,
      onCycle: cycle => artifact.record('mcp-cycle', cycle),
    })
    const invariants = [
      { name: 'all MCP calls match their expected success/error outcome', passed: result.passed === result.requests },
      { name: 'every lifecycle cycle has no unexpected protocol result', passed: result.unexpected.length === 0,
        detail: result.unexpected.slice(0, 8).join('; ') },
      { name: 'error translation is exercised', passed: result.expectedErrors > 0 || result.requests < 3 },
    ]
    const passed = invariants.every(item => item.passed)
    const summary = await artifact.finish({
      status: passed ? 'passed' : 'failed', config, invariants,
      metrics: { ...result },
    })
    console.log(JSON.stringify({
      scenario: 'SDK tool -> MCP server -> MCP client -> SDK ToolCatalog',
      protocol: 'real MCP initialize + tools/list + tools/call over linked in-memory transport',
      ...result, artifact: summary.artifact.directory,
    }, null, 2))
    if (!passed) process.exitCode = 1
  } catch (error: unknown) {
    const summary = await artifact.finish({ status: 'failed', config, error })
    console.error(JSON.stringify({ status: 'failed', artifact: summary.artifact.directory,
      error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  }
}

function parseArgs(argv: readonly string[]): {
  readonly requests: number
  readonly parallel: number
  readonly cycles: number
  readonly runId?: string
  readonly resultsRoot: string
  readonly dryRun: boolean
} {
  const input = stripCommandSeparators(argv)
  let requests = 1
  let parallel = 1
  let cycles = 1
  let runId: string | undefined
  let resultsRoot = resolve('test-human/results/mcp')
  let dryRun = false
  for (let index = 0; index < input.length; index++) {
    const flag = input[index]
    if (flag === '--dry-run') { dryRun = true; continue }
    const value = input[++index]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    if (flag === '--requests') requests = positive(value, flag)
    else if (flag === '--parallel') parallel = positive(value, flag)
    else if (flag === '--cycles') cycles = positive(value, flag)
    else if (flag === '--run-id') runId = value
    else if (flag === '--results-root') resultsRoot = resolve(value)
    else throw new Error(`unknown MCP human option: ${flag}`)
  }
  return {
    requests, parallel, cycles, resultsRoot, dryRun,
    ...(runId === undefined ? {} : { runId }),
  }
}

function positive(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`)
  return value
}
