// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateImplementationLedger(ctx: ContractContext): void {
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

  const ledger = readFileSync(join(workspace, 'docs/core-capability-implementation-todo.md'), 'utf8')
  const normalizedLedger = ledger.replace(/\s+/g, ' ')
  assertSameSet(
    'implementation slice IDs',
    new Set(ledger.match(/\bI\d+\b/g) ?? []),
    new Set(Array.from({ length: 9 }, (_, index) => `I${index}`)),
  )
  for (const invariant of [
    'route-complete re-export bridge',
    'no copied source or independent',
    'shrink monotonically',
    'I7 is mandatory',
    'Historical spike reports remain evidence',
    'Targeted provider/network/runtime acceptance is owner-authorized',
    'superseded executable source was removed',
    'execute any live or credentialed entrypoint',
  ]) {
    if (!normalizedLedger.includes(invariant)) {
      fail(`implementation ledger lacks bridge/evidence invariant '${invariant}'`)
    }
  }
}
// @ts-nocheck
