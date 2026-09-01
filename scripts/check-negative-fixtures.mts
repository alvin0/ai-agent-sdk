#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const workspaceRoot = resolve(process.cwd())
const cases = [
  { script: 'check-package-graph.mts', fixture: 'graph-cycle', expected: 'workspace dependency cycle' },
  { script: 'check-package-graph.mts', fixture: 'graph-undeclared', expected: 'undeclared package import' },
  { script: 'check-package-graph.mts', fixture: 'graph-internal-import', expected: 'import bypasses' },
  { script: 'check-runtime-boundaries.mts', fixture: 'runtime-node-leak', expected: 'Node builtin import' },
  { script: 'check-runtime-boundaries.mts', fixture: 'runtime-emitted-leak', expected: 'dist/index.js:1: Node builtin import' },
] as const

const failures: string[] = []
for (const testCase of cases) {
  const script = join(workspaceRoot, 'scripts', testCase.script)
  const fixture = join(workspaceRoot, 'tests', 'negative-fixtures', testCase.fixture)
  const result = spawnSync(process.execPath, [script, '--root', fixture], { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0) failures.push(`${testCase.fixture}: checker unexpectedly passed`)
  else if (!output.includes(testCase.expected)) failures.push(`${testCase.fixture}: missing expected finding ${JSON.stringify(testCase.expected)}`)
  else console.log(`${testCase.fixture}: rejected as expected (${testCase.expected})`)
}

const sourceCycleRoot = join(workspaceRoot, 'tests', 'negative-fixtures', 'source-ownership-cycle', 'src')
const sourceCycle = spawnSync(process.execPath, [join(workspaceRoot, 'scripts', 'check-source-cycles.mts'), sourceCycleRoot], { encoding: 'utf8' })
const sourceCycleOutput = `${sourceCycle.stdout ?? ''}${sourceCycle.stderr ?? ''}`
if (sourceCycle.status === 0) failures.push('source-ownership-cycle: checker unexpectedly passed')
else if (!sourceCycleOutput.includes('runtime -> stream -> runtime')) failures.push('source-ownership-cycle: missing expected type-only ownership cycle')
else console.log('source-ownership-cycle: rejected as expected (runtime -> stream -> runtime)')

if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  const safeFixture = join(workspaceRoot, 'tests', 'negative-fixtures', 'runtime-safe')
  const safe = spawnSync(process.execPath, [join(workspaceRoot, 'scripts', 'check-runtime-boundaries.mts'), '--root', safeFixture], { encoding: 'utf8' })
  if (safe.status !== 0) {
    process.stderr.write(`${safe.stdout ?? ''}${safe.stderr ?? ''}`)
    process.exitCode = 1
  } else {
    console.log(`Boundary fixtures passed: ${cases.length + 1} invalid workspaces rejected and the safe lexical fixture accepted.`)
  }
}
