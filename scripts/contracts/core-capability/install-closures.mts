// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function assertInstallRecipeClosures(ctx: ContractContext): void {
  const {
    workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
  } = ctx
  const {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  } = makeHelpers(workspace, topology)
  const { readFileSync, existsSync, readdirSync } = fs
  const { join, resolve, dirname } = path
  const { createHash } = crypto
  void [
    workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
    readFileSync, existsSync, readdirSync, join, resolve, dirname, createHash,
    analyzeSourceOwnershipGraph,
  ]

  const closurePolicy = installClosures.policy
  if (closurePolicy.optionalPeersExcludedUntilExplicitlySelected !== true
    || closurePolicy.requiredCorePeerMustBeDirect !== true
    || closurePolicy.externalSelectionsInclude !== 'runtime-dependencies-and-required-peers') {
    fail('install-closure baseline policy drifted')
  }
  assertSameSet(
    'install-closure journey IDs',
    new Set(Object.keys(installClosures.journeys)),
    new Set(topology.journeys.map(journey => journey.id)),
  )
  for (const journey of topology.journeys) {
    const expected = installClosures.journeys[journey.id]
    if (expected === undefined) fail(`missing install-closure baseline '${journey.id}'`)
    if (new Set(expected.workspaceClosure).size !== expected.workspaceClosure.length
      || new Set(expected.externalClosure).size !== expected.externalClosure.length) {
      fail(`install-closure baseline '${journey.id}' contains duplicate entries`)
    }
    const workspacePackages = workspaceClosure(new Set(journey.packages))
    assertSameSet(
      `${journey.id} frozen workspace install closure`,
      workspacePackages,
      new Set(expected.workspaceClosure),
    )
    assertSameSet(
      `${journey.id} frozen external install closure`,
      externalClosure(workspacePackages),
      new Set(expected.externalClosure),
    )
    const effectiveRuntime = [...workspacePackages].reduce<Runtime>((runtime, packageName) => {
      const selectedRuntime = topology.packages[packageName]?.runtime ?? 'universal'
      return runtimeRank(selectedRuntime) > runtimeRank(runtime) ? selectedRuntime : runtime
    }, 'universal')
    if (effectiveRuntime !== expected.effectiveRuntime || effectiveRuntime !== journey.runtime) {
      fail(`install-closure baseline '${journey.id}' has an incorrect effective runtime`)
    }
  }

  const packageProbeNames = Object.keys(topology.packages)
    .filter(packageName => packageName !== '@ai-agent-sdk/core')
  assertSameSet(
    'package-local install closure probes',
    new Set(Object.keys(installClosures.packageProbes)),
    new Set(packageProbeNames),
  )
  for (const packageName of packageProbeNames) {
    const expected = installClosures.packageProbes[packageName]
    if (expected === undefined) fail(`missing package-local closure probe '${packageName}'`)
    if (new Set(expected.workspaceClosure).size !== expected.workspaceClosure.length
      || new Set(expected.externalClosure).size !== expected.externalClosure.length) {
      fail(`package-local closure probe '${packageName}' contains duplicate entries`)
    }
    const workspacePackages = workspaceClosure(new Set(['@ai-agent-sdk/core', packageName]))
    assertSameSet(
      `${packageName} package-local workspace closure`,
      workspacePackages,
      new Set(expected.workspaceClosure),
    )
    assertSameSet(
      `${packageName} package-local external closure`,
      externalClosure(workspacePackages),
      new Set(expected.externalClosure),
    )
    const effectiveRuntime = [...workspacePackages].reduce<Runtime>((runtime, selectedPackage) => {
      const selectedRuntime = topology.packages[selectedPackage]?.runtime ?? 'universal'
      return runtimeRank(selectedRuntime) > runtimeRank(runtime) ? selectedRuntime : runtime
    }, 'universal')
    if (effectiveRuntime !== expected.effectiveRuntime
      || effectiveRuntime !== topology.packages[packageName]?.runtime) {
      fail(`package-local closure probe '${packageName}' has an incorrect effective runtime`)
    }
  }

  const expectedMinimal = new Set([
    '@ai-agent-sdk/core',
    '@ai-agent-sdk/provider-openai',
    '@ai-agent-sdk/provider-http',
    '@ai-agent-sdk/protocol-responses',
  ])
  for (const journeyId of ['edge-minimal', 'node-minimal']) {
    const journey = topology.journeys.find(candidate => candidate.id === journeyId)
    if (journey === undefined) fail(`missing install recipe '${journeyId}'`)
    const closure = workspaceClosure(new Set(journey.packages))
    assertSameSet(`${journeyId} workspace install closure`, closure, expectedMinimal)
    assertSameSet(
      `${journeyId} external install closure`,
      externalClosure(closure),
      new Set(['eventsource-parser@4.1.0']),
    )
  }

  const providerRecipes = new Map([
    ['anthropic-minimal', new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/provider-anthropic',
      '@ai-agent-sdk/provider-http',
      '@ai-agent-sdk/protocol-anthropic-messages',
    ])],
    ['codex-injected-minimal', new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/provider-codex',
      '@ai-agent-sdk/provider-http',
      '@ai-agent-sdk/protocol-responses',
    ])],
  ])
  for (const [journeyId, expectedClosure] of providerRecipes) {
    const journey = topology.journeys.find(candidate => candidate.id === journeyId)
    if (journey === undefined) fail(`missing install recipe '${journeyId}'`)
    const closure = workspaceClosure(new Set(journey.packages))
    assertSameSet(`${journeyId} workspace install closure`, closure, expectedClosure)
    assertSameSet(
      `${journeyId} external install closure`,
      externalClosure(closure),
      new Set(['eventsource-parser@4.1.0']),
    )
    if (closure.has('@ai-agent-sdk/auth-node')) {
      fail(`${journeyId} Universal provider recipe unexpectedly installs auth-node`)
    }
  }

  assertSameSet(
    'core-only workspace install closure',
    workspaceClosure(new Set(['@ai-agent-sdk/core'])),
    new Set(['@ai-agent-sdk/core']),
  )
  assertSameSet(
    'core-only external install closure',
    externalClosure(new Set(['@ai-agent-sdk/core'])),
    new Set(),
  )

  assertSameSet(
    'auth env-only workspace install closure',
    workspaceClosure(new Set(['@ai-agent-sdk/core', '@ai-agent-sdk/auth-node'])),
    new Set(['@ai-agent-sdk/core', '@ai-agent-sdk/auth-node']),
  )
  assertSameSet(
    'auth env-only external install closure',
    externalClosure(new Set(['@ai-agent-sdk/core', '@ai-agent-sdk/auth-node'])),
    new Set(),
  )
  const codexNodeClosure = workspaceClosure(new Set([
    '@ai-agent-sdk/core',
    '@ai-agent-sdk/auth-node',
    '@ai-agent-sdk/provider-codex',
  ]))
  assertSameSet(
    'auth Codex workspace install closure',
    codexNodeClosure,
    new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/auth-node',
      '@ai-agent-sdk/provider-codex',
      '@ai-agent-sdk/provider-http',
      '@ai-agent-sdk/protocol-responses',
    ]),
  )
  assertSameSet(
    'auth Codex external install closure',
    externalClosure(codexNodeClosure),
    new Set(['eventsource-parser@4.1.0']),
  )

  for (const journeyId of ['edge-capabilities', 'node-harness']) {
    const journey = topology.journeys.find(candidate => candidate.id === journeyId)
    if (journey === undefined) fail(`missing install recipe '${journeyId}'`)
    const closure = workspaceClosure(new Set(journey.packages))
    for (const serverPackage of ['@ai-agent-sdk/mcp-server', '@ai-agent-sdk/mcp-node-server']) {
      if (closure.has(serverPackage)) {
        fail(`${journeyId} client recipe unexpectedly installs '${serverPackage}'`)
      }
    }
  }
}
// @ts-nocheck
