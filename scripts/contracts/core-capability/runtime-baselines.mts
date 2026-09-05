// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateRuntimeBaselines(ctx: ContractContext): void {
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
  assertSameSet(
    'Universal runtime feature baseline',
    new Set(topology.runtimeBaselines.universal.requiredFeatures),
    new Set([
      'AbortController',
      'AbortSignal.any',
      'AbortSignal.timeout',
      'DOMException',
      'ReadableStream',
      'TextDecoder',
      'TextEncoder',
      'URL',
      'crypto.getRandomValues',
      'performance.now',
      'structuredClone',
      'timers',
    ]),
  )
  if (topology.runtimeBaselines.browser.extends !== 'universal') {
    fail('Browser runtime baseline must extend Universal')
  }
  assertSameSet(
    'Browser runtime feature baseline',
    new Set(topology.runtimeBaselines.browser.requiredFeatures),
    new Set(['globalThis.addEventListener', 'indexedDB']),
  )
  if (topology.runtimeBaselines.node.extends !== 'universal'
    || topology.runtimeBaselines.node.minimumVersion !== '22.12.0') {
    fail('Node runtime baseline must extend Universal and require Node 22.12.0')
  }
  assertSameSet(
    'Node runtime feature baseline',
    new Set(topology.runtimeBaselines.node.requiredFeatures),
    new Set(['node:module-resolution']),
  )
}
// @ts-nocheck
