#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const topology = JSON.parse(readFileSync(resolve(root,
  'design-contracts/core-capability-v1/topology.json'), 'utf8')) as {
  readonly packages: Readonly<Record<string, {
    readonly externalRuntimeDependencies?: readonly string[]
    readonly requiredExternalRuntimePeers?: readonly string[]
  }>>
}
const report = JSON.parse(readFileSync(resolve(root,
  'design-contracts/core-capability-v1/runtime-dependency-report.json'), 'utf8')) as {
  readonly targetPackageCount: number
  readonly uniqueDirectThirdPartyRuntimeDependencies: readonly string[]
  readonly uniqueInstalledThirdPartyRuntimeClosure: readonly string[]
  readonly perPackage: Readonly<Record<string, readonly string[]>>
}
const names = Object.keys(topology.packages).sort()
assert(report.targetPackageCount === names.length, 'target package count drifted')
assertSame('per-package keys', Object.keys(report.perPackage), names)

const direct = new Set<string>()
const installed = new Set<string>()
for (const name of names) {
  const rule = topology.packages[name]
  for (const dependency of [
    ...rule?.externalRuntimeDependencies ?? [],
    ...rule?.requiredExternalRuntimePeers ?? [],
  ]) direct.add(dependency)
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--filter', name, 'list', '--prod', '--depth', 'Infinity', '--json',
  ], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`could not inspect ${name}: ${result.stderr}`)
  const rows = JSON.parse(result.stdout) as Array<{ readonly dependencies?: Readonly<Record<string, DependencyNode>> }>
  const closure = new Set<string>()
  collect(rows[0]?.dependencies, closure)
  for (const peer of rule?.requiredExternalRuntimePeers ?? []) closure.add(peer)
  const actual = [...closure].sort()
  assertSame(`${name} runtime closure`, actual, report.perPackage[name] ?? [])
  for (const dependency of actual) installed.add(dependency)
}
assertSame('direct third-party runtime dependencies', [...direct].sort(), report.uniqueDirectThirdPartyRuntimeDependencies)
assertSame('installed third-party runtime closure', [...installed].sort(), report.uniqueInstalledThirdPartyRuntimeClosure)
console.log(`Runtime dependency report passed: ${names.length} target packages, ${direct.size} unique direct roots, ${installed.size} unique installed packages.`)

interface DependencyNode {
  readonly from: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, DependencyNode>>
}

function collect(nodes: Readonly<Record<string, DependencyNode>> | undefined, output: Set<string>): void {
  for (const node of Object.values(nodes ?? {})) {
    if (!node.from.startsWith('@ai-agent-sdk/')) output.add(`${node.from}@${node.version}`)
    collect(node.dependencies, output)
  }
}

function assertSame(label: string, actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort(), right = [...expected].sort()
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} drifted: ${JSON.stringify(left)}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
