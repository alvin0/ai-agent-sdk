// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateDeclarationGraph(ctx: ContractContext): void {
  const { workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics, expectedManifestRoles } = ctx
  const { relative, fail, runtimeRank, assertSameSet, parseImports, importsOf, assertParser, targetDeclarationExportsOf,
    listFiles, listCodeFiles, externalPackageName, externalImportOwner, workspaceClosure } =
    makeHelpers(workspace, topology)
  const { readFileSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics, expectedManifestRoles, relative, fail,
    runtimeRank, assertSameSet, parseImports, importsOf, assertParser, targetDeclarationExportsOf, listFiles, listCodeFiles,
    externalPackageName, externalImportOwner, workspaceClosure, readFileSync, join, resolve]
  let declarationEdges = metrics.declarationEdges
  const externalRuntimeDependencies = metrics.externalRuntimeDependencies
for (const [packageName, rule] of Object.entries(topology.packages)) {
  const dependencies = new Set<string>()
  declarationDependencies.set(packageName, dependencies)
  const directory = join(contractRoot, 'packages', rule.declarationDir)
  const files = listFiles(directory, '.d.ts')
  if (files.length === 0) fail(`package '${packageName}' has no declaration file`)
  for (const file of files) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) {
        if (rule.runtime !== 'node') {
          fail(`${rule.runtime} package '${packageName}' imports Node builtin '${specifier}' in ${relative(file)}`)
        }
        continue
      }
      if (specifier.startsWith('.')) continue
      const dependency = packageBySpecifier.get(specifier)
      if (dependency === undefined) {
        const declaredExternalNames = new Set([
          ...rule.externalRuntimeDependencies,
          ...(rule.requiredExternalRuntimePeers ?? []),
          ...(rule.optionalExternalRuntimePeers ?? []),
        ].map(externalPackageName))
        if (!declaredExternalNames.has(externalImportOwner(specifier))) {
          fail(`undeclared package import '${specifier}' in ${relative(file)}`)
        }
        declarationEdges++
        continue
      }
      dependencies.add(dependency)
      declarationEdges++
      const dependencyRuntime = topology.packages[dependency]?.runtime ?? 'universal'
      if (runtimeRank(dependencyRuntime) > runtimeRank(rule.runtime)) {
        fail(`${rule.runtime} package '${packageName}' imports ${dependencyRuntime} package '${dependency}'`)
      }
    }
  }
}


  const externalSelectionByName = new Map<string, string>()
for (const [packageName, rule] of Object.entries(topology.packages)) {
  if (new Set(rule.manifestRoles).size !== rule.manifestRoles.length) {
    fail(`package '${packageName}' repeats a manifest capability role`)
  }
  assertSameSet(
    `package '${packageName}' manifest capability roles`,
    new Set(rule.manifestRoles),
    new Set(expectedManifestRoles.get(packageName) ?? []),
  )
  const isCore = packageName === '@ai-agent-sdk/core'
  if (isCore && rule.corePeer !== 'none') fail('core cannot peer on itself')
  if (!isCore && rule.corePeer !== 'required') {
    fail(`target package '${packageName}' must declare a bounded core peer`)
  }
  if (rule.normalWorkspaceDependencies.includes('@ai-agent-sdk/core')) {
    fail(`target package '${packageName}' declares core as a normal dependency`)
  }
  if (declarationDependencies.get(packageName)?.has('@ai-agent-sdk/core') === true
    && rule.corePeer !== 'required') {
    fail(`package '${packageName}' imports core values/types without a core peer`)
  }
  if (new Set(rule.normalWorkspaceDependencies).size !== rule.normalWorkspaceDependencies.length) {
    fail(`package '${packageName}' repeats a normal workspace dependency`)
  }
  if (new Set(rule.optionalWorkspacePeers).size !== rule.optionalWorkspacePeers.length) {
    fail(`package '${packageName}' repeats an optional workspace peer`)
  }
  for (const dependency of rule.normalWorkspaceDependencies) {
    const dependencyRule = topology.packages[dependency]
    if (dependencyRule === undefined) fail(`package '${packageName}' names unknown dependency '${dependency}'`)
    if (rule.optionalWorkspacePeers.includes(dependency)) {
      fail(`package '${packageName}' names '${dependency}' as both a dependency and optional peer`)
    }
    if (runtimeRank(dependencyRule.runtime) > runtimeRank(rule.runtime)) {
      fail(`${rule.runtime} package '${packageName}' normally depends on ${dependencyRule.runtime} package '${dependency}'`)
    }
  }
  for (const peer of rule.optionalWorkspacePeers) {
    const peerRule = topology.packages[peer]
    if (peerRule === undefined) fail(`package '${packageName}' names unknown optional peer '${peer}'`)
    if (peer === '@ai-agent-sdk/core') fail(`package '${packageName}' cannot make its core peer optional`)
    if (runtimeRank(peerRule.runtime) > runtimeRank(rule.runtime)) {
      fail(`${rule.runtime} package '${packageName}' has an unclassified ${peerRule.runtime} optional-peer route '${peer}'`)
    }
  }
  for (const [specifier, peer] of Object.entries(rule.specifierPeerRequirements ?? {})) {
    if (!rule.specifiers.includes(specifier)) {
      fail(`package '${packageName}' has a peer requirement for unknown specifier '${specifier}'`)
    }
    if (!rule.optionalWorkspacePeers.includes(peer)) {
      fail(`specifier '${specifier}' requires '${peer}', but it is not an optional peer`)
    }
  }
  assertSameSet(
    `package '${packageName}' route-scoped optional workspace peers`,
    new Set(Object.values(rule.specifierPeerRequirements ?? {})),
    new Set(rule.optionalWorkspacePeers),
  )
  const externalSelections = [
    ...rule.externalRuntimeDependencies,
    ...(rule.requiredExternalRuntimePeers ?? []),
    ...(rule.optionalExternalRuntimePeers ?? []),
  ]
  if (new Set(externalSelections).size !== externalSelections.length) {
    fail(`package '${packageName}' repeats an external runtime dependency/peer`)
  }
  const localExternalNames = new Set<string>()
  for (const dependency of externalSelections) {
    if (!/^(?:@[^/]+\/[^@]+|[^@]+)@\d+\.\d+\.\d+(?:[-+].+)?$/.test(dependency)) {
      fail(`external runtime dependency '${dependency}' must use an exact version`)
    }
    const dependencyName = externalPackageName(dependency)
    if (localExternalNames.has(dependencyName)) {
      fail(`package '${packageName}' assigns external package '${dependencyName}' to multiple manifest sections`)
    }
    localExternalNames.add(dependencyName)
    const existingSelection = externalSelectionByName.get(dependencyName)
    if (existingSelection !== undefined && existingSelection !== dependency) {
      fail(`external package '${dependencyName}' has conflicting exact selections '${existingSelection}' and '${dependency}'`)
    }
    externalSelectionByName.set(dependencyName, dependency)
    externalRuntimeDependencies.add(dependency)
  }
}

if (topology.packages['@ai-agent-sdk/core']?.externalRuntimeDependencies.length !== 0) {
  fail('target core must have zero external runtime dependencies')
}

assertSameSet(
  'Universal MCP client external closure',
  new Set(topology.packages['@ai-agent-sdk/mcp']?.externalRuntimeDependencies ?? []),
  new Set(['@modelcontextprotocol/client@2.0.0']),
)
assertSameSet(
  'Universal MCP server external closure',
  new Set(topology.packages['@ai-agent-sdk/mcp-server']?.externalRuntimeDependencies ?? []),
  new Set(['@modelcontextprotocol/server@2.0.0']),
)
assertSameSet(
  'Node MCP client external closure',
  new Set(topology.packages['@ai-agent-sdk/mcp-node']?.externalRuntimeDependencies ?? []),
  new Set(['@modelcontextprotocol/client@2.0.0']),
)
assertSameSet(
  'Node MCP server external closure',
  new Set(topology.packages['@ai-agent-sdk/mcp-node-server']?.externalRuntimeDependencies ?? []),
  new Set(['@modelcontextprotocol/node@2.0.0', '@modelcontextprotocol/server@2.0.0']),
)
for (const journeyId of ['edge-capabilities', 'node-harness']) {
  const journey = topology.journeys.find(candidate => candidate.id === journeyId)
  if (journey?.packages.some(packageName => packageName.includes('mcp-server')) === true) {
    fail(`client journey '${journeyId}' must not select an MCP server package`)
  }
}
  metrics.declarationEdges = declarationEdges
}
// @ts-nocheck
