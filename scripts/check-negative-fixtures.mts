#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workspaceRoot = resolve(process.cwd())
const cases = [
  { script: 'check-package-graph.mts', fixture: 'graph-cycle', expected: 'workspace dependency cycle' },
  { script: 'check-package-graph.mts', fixture: 'source-ownership-cycle', expected: 'source ownership cycle' },
  { script: 'check-package-graph.mts', fixture: 'graph-undeclared', expected: 'undeclared package import' },
  { script: 'check-package-graph.mts', fixture: 'graph-internal-import', expected: 'import bypasses' },
  { script: 'check-runtime-boundaries.mts', fixture: 'runtime-node-leak', expected: 'Node builtin import' },
  { script: 'check-runtime-boundaries.mts', fixture: 'runtime-emitted-leak', expected: 'dist/index.js:1: Node builtin import' },
  { script: 'check-agent-boundaries.mts', fixture: 'agent-team-cycle', expected: 'define/session imports team implementation' },
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

const matrixPath = join(workspaceRoot, 'tests', 'negative-fixtures', 'package-matrix.json')
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as {
  readonly packages: Readonly<Record<string, 'universal' | 'browser' | 'node'>>
}
const matrixRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-negative-packages-'))
try {
  for (const [packageName, runtime] of Object.entries(matrix.packages)) {
    const slug = packageName.slice(packageName.lastIndexOf('/') + 1)
    const dependencyRoot = join(matrixRoot, 'dependency', slug, 'packages', slug)
    mkdirSync(join(dependencyRoot, 'src'), { recursive: true })
    writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({
      name: packageName,
      version: '0.0.0',
      type: 'module',
      aiAgentSdk: { runtime },
    }))
    writeFileSync(join(dependencyRoot, 'src', 'index.ts'), "import 'fixture-hidden-runtime-dependency'\n")
    const dependencyResult = spawnSync(process.execPath, [
      join(workspaceRoot, 'scripts', 'check-package-graph.mts'),
      '--root', join(matrixRoot, 'dependency', slug),
    ], { encoding: 'utf8' })
    const dependencyOutput = `${dependencyResult.stdout ?? ''}${dependencyResult.stderr ?? ''}`
    if (dependencyResult.status === 0 || !dependencyOutput.includes('undeclared package import')) {
      failures.push(`${packageName}: hidden dependency fixture was not rejected`)
    }

    const runtimeFixtureRoot = join(matrixRoot, 'runtime', slug)
    if (runtime === 'node') {
      const coreRoot = join(runtimeFixtureRoot, 'packages', 'core')
      const targetRoot = join(runtimeFixtureRoot, 'packages', slug)
      mkdirSync(join(coreRoot, 'src'), { recursive: true })
      mkdirSync(targetRoot, { recursive: true })
      writeFileSync(join(coreRoot, 'package.json'), JSON.stringify({
        name: '@ai-agent-sdk/core', version: '0.0.0', type: 'module',
        dependencies: { [packageName]: 'workspace:*' }, aiAgentSdk: { runtime: 'universal' },
      }))
      writeFileSync(join(coreRoot, 'src', 'index.ts'), `import '${packageName}'\n`)
      writeFileSync(join(targetRoot, 'package.json'), JSON.stringify({
        name: packageName, version: '0.0.0', type: 'module', aiAgentSdk: { runtime: 'node' },
      }))
      const runtimeResult = spawnSync(process.execPath, [
        join(workspaceRoot, 'scripts', 'check-package-graph.mts'), '--root', runtimeFixtureRoot,
      ], { encoding: 'utf8' })
      const runtimeOutput = `${runtimeResult.stdout ?? ''}${runtimeResult.stderr ?? ''}`
      if (runtimeResult.status === 0 || !runtimeOutput.includes('cannot depend on Node package')) {
        failures.push(`${packageName}: Node escalation fixture was not rejected`)
      }
    } else {
      const targetRoot = join(runtimeFixtureRoot, 'packages', slug)
      mkdirSync(join(targetRoot, 'src'), { recursive: true })
      writeFileSync(join(targetRoot, 'package.json'), JSON.stringify({
        name: packageName, version: '0.0.0', type: 'module', aiAgentSdk: { runtime },
      }))
      writeFileSync(join(targetRoot, 'src', 'index.ts'), "import 'node:fs'\n")
      const runtimeResult = spawnSync(process.execPath, [
        join(workspaceRoot, 'scripts', 'check-runtime-boundaries.mts'), '--root', runtimeFixtureRoot,
      ], { encoding: 'utf8' })
      const runtimeOutput = `${runtimeResult.stdout ?? ''}${runtimeResult.stderr ?? ''}`
      if (runtimeResult.status === 0 || !runtimeOutput.includes('Node builtin import')) {
        failures.push(`${packageName}: Web runtime fixture was not rejected`)
      }
    }
  }
  console.log(`Per-package negative matrix checked ${Object.keys(matrix.packages).length} dependency closures and runtime boundaries.`)
} finally {
  rmSync(matrixRoot, { recursive: true, force: true })
}

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
    console.log(`Boundary fixtures passed: ${cases.length} invalid workspaces rejected and the safe lexical fixture accepted.`)
  }
}
