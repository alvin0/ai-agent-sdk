// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateProviderApiBaseline(ctx: ContractContext): void {
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
  const tsconfig = JSON.parse(readFileSync(join(contractRoot, 'tsconfig.json'), 'utf8')) as {
    readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> }
  }

  if (providerApiBaseline.policy !== 'preserve-unless-owner-approved') {
    fail('retained provider API baseline must default to preservation')
  }
  assertSameSet(
    'retained provider API baseline packages',
    new Set(Object.keys(providerApiBaseline.sources)),
    new Set([
      '@ai-agent-sdk/provider-http',
      '@ai-agent-sdk/provider-openai',
      '@ai-agent-sdk/provider-anthropic',
      '@ai-agent-sdk/provider-codex',
    ]),
  )
  const targetMissing: string[] = []
  for (const [sourcePackage, source] of Object.entries(providerApiBaseline.sources)) {
    if (source.targetSpecifier !== sourcePackage || !packageBySpecifier.has(source.targetSpecifier)) {
      fail(`retained provider API '${sourcePackage}' must keep its package specifier`)
    }
    if (source.remove.length !== 0) {
      fail(`retained provider API '${sourcePackage}' proposes an unapproved removal`)
    }
    const declarationPath = join(workspace, source.declaration)
    const baseline = new Set(source.exports)
    if (baseline.size !== source.exports.length) {
      fail(`retained provider API '${sourcePackage}' contains duplicate symbols`)
    }
    const additive = new Set(source.additiveExports)
    if (additive.size !== source.additiveExports.length
      || [...additive].some(symbol => baseline.has(symbol))) {
      fail(`retained provider API '${sourcePackage}' contains invalid additive symbols`)
    }
    assertSameSet(
      `retained provider API plus reviewed additions '${sourcePackage}'`,
      publicExportsOf(declarationPath),
      new Set([...baseline, ...additive]),
    )
    const targetPath = tsconfig.compilerOptions?.paths?.[source.targetSpecifier]?.[0]
    if (targetPath === undefined) {
      fail(`retained provider API '${sourcePackage}' has no target declaration mapping`)
    }
    const targetExports = targetDeclarationExportsOf(resolve(contractRoot, targetPath))
    const missing = [...baseline].filter(symbol => !targetExports.has(symbol)).sort()
    targetMissing.push(...missing.map(symbol => `${sourcePackage}:${symbol}`))
    metrics.providerApiBaselineSymbolCount += baseline.size
  }
  if (metrics.providerApiBaselineSymbolCount !== 84) {
    fail(`retained provider API baseline accounting drifted: ${metrics.providerApiBaselineSymbolCount}`)
  }
  if (targetMissing.length > 0) {
    fail(`retained provider targets miss ${targetMissing.length}: ${targetMissing.join(', ')}`)
  }
}
// @ts-nocheck
