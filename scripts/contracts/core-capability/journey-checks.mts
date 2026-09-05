// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import { assertInstallRecipeClosures } from './install-closures.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateJourneyAndRemovals(ctx: ContractContext): void {
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
for (const journey of topology.journeys) {
  const file = join(contractRoot, journey.file)
  const selected = new Set<string>()
  const importedSpecifiers = importsOf(file)
  for (const specifier of importedSpecifiers) {
    if (specifier.startsWith('node:')) fail(`journey '${journey.id}' imports Node builtin '${specifier}'`)
    if (specifier.startsWith('.')) continue
    const packageName = packageBySpecifier.get(specifier)
    if (packageName === undefined) fail(`journey '${journey.id}' imports undeclared package '${specifier}'`)
    selected.add(packageName)
    if (topology.forbiddenPackages.includes(packageName)) {
      fail(`journey '${journey.id}' imports forbidden facade/split package '${packageName}'`)
    }
  }
  assertSameSet(`journey '${journey.id}' package selection`, selected, new Set(journey.packages))
  if (![...selected].every(packageName => packageName === '@ai-agent-sdk/core'
    || topology.packages[packageName]?.corePeer !== 'required'
    || selected.has('@ai-agent-sdk/core'))) {
    fail(`journey '${journey.id}' selects a core capability without selecting core explicitly`)
  }
  for (const specifier of importedSpecifiers) {
    const packageName = packageBySpecifier.get(specifier)
    if (packageName === undefined) continue
    const requiredPeer = topology.packages[packageName]?.specifierPeerRequirements?.[specifier]
    if (requiredPeer !== undefined && !selected.has(requiredPeer)) {
      fail(`journey '${journey.id}' imports '${specifier}' without optional peer '${requiredPeer}'`)
    }
  }
  const closure = workspaceClosure(selected)
  const requiredExternalPeers = new Set(
    [...closure].flatMap(packageName =>
      topology.packages[packageName]?.requiredExternalRuntimePeers ?? []),
  )
  assertSameSet(
    `journey '${journey.id}' direct required external peers`,
    new Set(journey.directExternalPackages ?? []),
    requiredExternalPeers,
  )
  const effectiveRuntime = [...closure].reduce<Runtime>((runtime, packageName) => {
    const selectedRuntime = topology.packages[packageName]?.runtime ?? 'universal'
    return runtimeRank(selectedRuntime) > runtimeRank(runtime) ? selectedRuntime : runtime
  }, 'universal')
  if (effectiveRuntime !== journey.runtime) {
    fail(`journey '${journey.id}' declares ${journey.runtime} but composes to ${effectiveRuntime}`)
  }
}
assertSameSet(
  'direct target-package journey coverage',
  new Set(topology.journeys.flatMap(journey => journey.packages)),
  new Set(Object.keys(topology.packages)),
)

const edgeWorkerJourney = topology.journeys.find(journey => journey.id === 'edge-worker-chat')
if (edgeWorkerJourney === undefined) fail('target journeys do not prove the Edge Worker website boundary')
const edgeWorkerSource = readFileSync(join(contractRoot, edgeWorkerJourney.file), 'utf8')
for (const proof of [
  'JSON.stringify([1, principalId, input.conversationId])',
  'additionalInstructions: DEEP_RESEARCH_INSTRUCTIONS',
  'projectToolEvent',
  'handle.runId',
  'sequence: sequence++',
  "send('failed'",
  "send('complete'",
  'async cancel(reason)',
  'handle.abort(reason)',
  'handle.report.catch',
  'AbortSignal.timeout(5_000)',
  "Response.json({ code: 'CONVERSATION_BUSY' }, { status: 409 })",
]) {
  if (!edgeWorkerSource.includes(proof)) fail(`Edge Worker website journey lacks '${proof}'`)
}
if (edgeWorkerSource.includes('input.instructions')) {
  fail('Edge Worker website journey forwards browser-controlled instructions')
}

const observabilityCompatibility = readFileSync(
  join(contractRoot, 'consumers/observability-api-compatibility.ts'),
  'utf8',
)
for (const proof of [
  "import * as Current from '@current/observability'",
  "import * as Target from '@ai-agent-sdk/core/observability'",
  'Current.ObservationBatch, Target.ObservationBatch',
  'Current.ObservationExporter, Target.ObservationExporter',
  'Current.ObservabilityOptions, Target.ObservabilityOptions',
  'typeof Current.createObservability, typeof Target.createObservability',
  'memoryPublicCompatibility',
  'testPublicCompatibility',
]) {
  if (!observabilityCompatibility.includes(proof)) {
    fail(`observability signature compatibility contract lacks '${proof}'`)
  }
}

assertInstallRecipeClosures(ctx)

for (const forbidden of topology.forbiddenPackages) {
  if (packageBySpecifier.has(forbidden)) fail(`forbidden package '${forbidden}' is mapped by the target contract`)
}

const currentCodeFiles = ['packages', 'test-human', 'tests', 'scripts']
  .flatMap(directory => listCodeFiles(join(workspace, directory)))
const currentImports = new Map(
  currentCodeFiles.map(file => [relative(file), importsOf(file)] as const),
)
for (const [removedPackage, inventory] of Object.entries(topology.removalMigrationInventory)) {
  if (!topology.forbiddenPackages.includes(removedPackage)) {
    fail(`removal inventory '${removedPackage}' must also be forbidden by target journeys`)
  }
  const actualFiles = new Set(
    [...currentImports.entries()]
      .filter(([, imports]) => imports.some(specifier =>
        specifier === removedPackage || specifier.startsWith(`${removedPackage}/`)))
      .map(([file]) => file),
  )
  assertSameSet(
    `removed package '${removedPackage}' (${inventory.action}) migration inventory`,
    actualFiles,
    new Set(inventory.expectedImportFiles),
  )
  if (inventory.replacementSpecifiers !== undefined) {
    const actualSpecifiers = new Set(
      [...currentImports.values()]
        .flat()
        .filter(specifier => specifier === removedPackage || specifier.startsWith(`${removedPackage}/`)),
    )
    for (const specifier of actualSpecifiers) {
      if (!(specifier in inventory.replacementSpecifiers)) {
        fail(`removed package '${removedPackage}' has no replacement route for '${specifier}'`)
      }
    }
    for (const [currentSpecifier, targetSpecifier] of Object.entries(inventory.replacementSpecifiers)) {
      if (!currentSpecifier.startsWith(removedPackage)
        || !packageBySpecifier.has(targetSpecifier)) {
        fail(`removed package '${removedPackage}' has invalid replacement '${currentSpecifier}' -> '${targetSpecifier}'`)
      }
    }
  }
}

}
// @ts-nocheck
