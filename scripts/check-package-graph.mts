#!/usr/bin/env node
import { builtinModules } from 'node:module'
import { relative, resolve } from 'node:path'
import {
  PACKAGE_RULES,
  declaredRuntimeDependencies,
  discoverWorkspacePackages,
  externalPackageName,
  importsInFile,
  isExportedWorkspaceSubpath,
  isWithin,
  listCodeFiles,
  resolveRelativeImport,
  type WorkspacePackage,
} from './package-policy.mts'

const args = process.argv.slice(2)
const rootIndex = args.indexOf('--root')
const workspaceRoot = resolve(rootIndex === -1 ? process.cwd() : (args[rootIndex + 1] ?? ''))
const errors: string[] = []
const packages = discoverWorkspacePackages(workspaceRoot)
const byName = new Map<string, WorkspacePackage>()
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

for (const pkg of packages) {
  if (byName.has(pkg.manifest.name)) errors.push(`duplicate workspace package name: ${pkg.manifest.name}`)
  byName.set(pkg.manifest.name, pkg)
  if (!PACKAGE_RULES[pkg.manifest.name]) errors.push(`${pkg.manifest.name}: package is absent from the normative allowlist`)
}

const edges = new Map<string, Set<string>>()
for (const pkg of packages) edges.set(pkg.manifest.name, new Set())

function addWorkspaceEdge(pkg: WorkspacePackage, dependency: string, context: string): void {
  const rule = PACKAGE_RULES[pkg.manifest.name]
  const targetRule = PACKAGE_RULES[dependency]
  edges.get(pkg.manifest.name)?.add(dependency)
  if (rule && !rule.workspaceDependencies.includes(dependency)) {
    errors.push(`${pkg.manifest.name}: forbidden workspace edge to ${dependency} (${context})`)
  }
  if (rule && targetRule && (rule.runtime === 'universal' || rule.runtime === 'browser') && targetRule.runtime === 'node') {
    errors.push(`${pkg.manifest.name}: ${rule.runtime} package cannot depend on Node package ${dependency}`)
  }
}

for (const pkg of packages) {
  const declared = declaredRuntimeDependencies(pkg.manifest)
  for (const dependency of declared) {
    if (byName.has(dependency)) addWorkspaceEdge(pkg, dependency, 'manifest')
  }

  for (const sourceRoot of pkg.sourceRoot ? [pkg.sourceRoot] : []) {
    for (const file of listCodeFiles(sourceRoot)) {
      for (const imported of importsInFile(file)) {
        const location = `${relative(workspaceRoot, file)}:${imported.line}`
        if (imported.specifier.startsWith('.')) {
          const target = resolveRelativeImport(file, imported.specifier)
          if (!isWithin(target, pkg.root)) errors.push(`${location}: relative import escapes package root: ${imported.specifier}`)
          continue
        }
        if (builtins.has(imported.specifier) || imported.specifier.startsWith('node:')) continue
        const external = externalPackageName(imported.specifier)
        if (!external) continue
        if (!declared.has(external)) errors.push(`${location}: undeclared package import ${external}`)

        const workspaceTarget = byName.get(external)
        if (workspaceTarget) {
          addWorkspaceEdge(pkg, external, `${location}, including type-only imports`)
          if (!isExportedWorkspaceSubpath(workspaceTarget, imported.specifier)) {
            errors.push(`${location}: import bypasses ${external} exports: ${imported.specifier}`)
          }
        } else {
          const rule = PACKAGE_RULES[pkg.manifest.name]
          if (rule && !rule.externalRuntimeDependencies.includes(external)) {
            errors.push(`${location}: ${pkg.manifest.name} does not own external runtime dependency ${external}`)
          }
        }
      }
    }
  }
}

const visiting = new Set<string>()
const visited = new Set<string>()
const path: string[] = []
const reportedCycles = new Set<string>()
const visit = (name: string): void => {
  if (visiting.has(name)) {
    const start = path.indexOf(name)
    const cycle = [...path.slice(start), name].join(' -> ')
    if (!reportedCycles.has(cycle)) errors.push(`workspace dependency cycle: ${cycle}`)
    reportedCycles.add(cycle)
    return
  }
  if (visited.has(name)) return
  visiting.add(name)
  path.push(name)
  for (const dependency of edges.get(name) ?? []) if (edges.has(dependency)) visit(dependency)
  path.pop()
  visiting.delete(name)
  visited.add(name)
}
for (const name of edges.keys()) visit(name)

if (errors.length > 0) {
  console.error(`Package graph check failed with ${errors.length} finding(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  const edgeCount = [...edges.values()].reduce((total, values) => total + values.size, 0)
  console.log(`Package graph check passed: ${packages.length} package(s), ${edgeCount} workspace edge(s), zero findings.`)
}
