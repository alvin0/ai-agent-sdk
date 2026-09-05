// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateRetainedPackageApiBaseline(ctx: ContractContext): void {
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

  if (retainedPackageApiBaseline.policy !== 'preserve-unless-owner-approved') {
    fail('retained non-core/provider API baseline must default to preservation')
  }
  const targetAudit = retainedPackageApiBaseline.targetAudit
  if (targetAudit.evidence !== 'exact-sorted-source-specifier-and-missing-symbol-sha256') {
    fail('retained package target audit evidence policy drifted')
  }
  const packageNames = new Set(
    Object.keys(retainedPackageApiBaseline.sources).map(specifier => packageNameOf(specifier)),
  )
  assertSameSet(
    'retained non-core/provider package inventory',
    packageNames,
    new Set([
      '@ai-agent-sdk/a2a',
      '@ai-agent-sdk/auth-node',
      '@ai-agent-sdk/mcp',
      '@ai-agent-sdk/mcp-node',
      '@ai-agent-sdk/skill-filesystem',
      '@ai-agent-sdk/protocol-responses',
      '@ai-agent-sdk/protocol-anthropic-messages',
      '@ai-agent-sdk/observability-fetch',
      '@ai-agent-sdk/observability-browser',
      '@ai-agent-sdk/observability-node',
      '@ai-agent-sdk/observability-otel',
    ]),
  )

  const currentSpecifiers = new Set<string>()
  for (const packageName of packageNames) {
    const manifestPath = join(workspace, 'packages', packageName.slice('@ai-agent-sdk/'.length), 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly name: string
      readonly exports: Readonly<Record<string, unknown>>
    }
    if (manifest.name !== packageName) fail(`retained package manifest name drifted for '${packageName}'`)
    for (const route of Object.keys(manifest.exports)) {
      if (route === './package.json') continue
      currentSpecifiers.add(route === '.' ? packageName : `${packageName}${route.slice(1)}`)
    }
  }
  assertSameSet(
    'retained non-core/provider current public entrypoints',
    new Set(Object.keys(retainedPackageApiBaseline.sources)),
    currentSpecifiers,
  )

  if (Object.keys(retainedPackageApiBaseline.sources).length !== targetAudit.expectedEntrypointCount) {
    fail('retained package target audit entrypoint accounting drifted')
  }
  const decisionIds = new Set(phase0.decisions.map(decision => decision.id))
  const missingInventory: string[] = []
  const missingByEntrypoint = new Map<string, number>()
  for (const [sourceSpecifier, source] of Object.entries(retainedPackageApiBaseline.sources)) {
    const declarationPath = join(workspace, source.declaration)
    const baseline = new Set(source.exports)
    if (baseline.size !== source.exports.length) {
      fail(`retained package API '${sourceSpecifier}' contains duplicate symbols`)
    }
    const additive = new Set(source.additiveExports ?? [])
    if (additive.size !== (source.additiveExports?.length ?? 0)
      || [...additive].some(symbol => baseline.has(symbol))) {
      fail(`retained package API '${sourceSpecifier}' contains invalid additive symbols`)
    }
    if (source.action === 'preserve-via-optional-peer-view') {
      const declarationText = readFileSync(declarationPath, 'utf8').trim()
      if (declarationText !== 'export * from "@ai-agent-sdk/mcp-server";') {
        fail(`optional-peer view '${sourceSpecifier}' must be an exact re-export`)
      }
    } else {
      const movedFromRoute = new Set(Object.values(source.movedExports ?? {}).flat())
      const expectedCurrent = new Set(
        [...baseline].filter(symbol => !movedFromRoute.has(symbol)).concat([...additive]),
      )
      assertSameSet(
        `retained package API plus reviewed additions '${sourceSpecifier}'`,
        publicExportsOf(declarationPath),
        expectedCurrent,
      )
    }
    metrics.retainedPackageApiBaselineSymbolCount += baseline.size

    if (source.targetSpecifiers.length === 0) {
      fail(`retained package API '${sourceSpecifier}' has no target route`)
    }
    for (const targetSpecifier of source.targetSpecifiers) {
      if (!packageBySpecifier.has(targetSpecifier)) {
        fail(`retained package API '${sourceSpecifier}' targets unknown '${targetSpecifier}'`)
      }
    }
    const targetExports = new Set<string>()
    const targetExportsBySpecifier = new Map<string, ReadonlySet<string>>()
    for (const targetSpecifier of source.targetSpecifiers) {
      const targetPath = tsconfig.compilerOptions?.paths?.[targetSpecifier]?.[0]
      if (targetPath === undefined) fail(`missing target declaration path for '${targetSpecifier}'`)
      const exports = targetDeclarationExportsOf(resolve(contractRoot, targetPath))
      targetExportsBySpecifier.set(targetSpecifier, exports)
      for (const symbol of exports) targetExports.add(symbol)
    }
    if (source.action === 'preserve') {
      assertSameSet(
        `preserved route '${sourceSpecifier}'`,
        new Set(source.targetSpecifiers),
        new Set([sourceSpecifier]),
      )
      if (source.decisionId !== undefined) {
        fail(`preserved route '${sourceSpecifier}' must not depend on an owner decision`)
      }
      if (source.movedExports !== undefined) {
        fail(`preserved route '${sourceSpecifier}' must not declare moved exports`)
      }
    } else {
      if (source.decisionId === undefined || !decisionIds.has(source.decisionId)) {
        fail(`retained route '${sourceSpecifier}' requires a valid owner decision`)
      }
      if (!source.targetSpecifiers.includes(sourceSpecifier)) {
        fail(`retained route '${sourceSpecifier}' must keep a same-specifier compatibility surface`)
      }
      if (source.action === 'preserve-via-optional-peer-view') {
        if (source.movedExports !== undefined) {
          fail(`optional-peer view '${sourceSpecifier}' must preserve, not move, its symbols`)
        }
        const packageRule = topology.packages[packageNameOf(sourceSpecifier)]
        if (packageRule?.specifierPeerRequirements?.[sourceSpecifier] === undefined) {
          fail(`optional-peer compatibility route '${sourceSpecifier}' lacks a peer requirement`)
        }
      } else {
        const movedExports = source.movedExports
        if (movedExports === undefined) {
          fail(`split route '${sourceSpecifier}' lacks an exact moved-export inventory`)
        }
        assertSameSet(
          `split route '${sourceSpecifier}' move targets`,
          new Set(Object.keys(movedExports)),
          new Set(source.targetSpecifiers.filter(specifier => specifier !== sourceSpecifier)),
        )
        const seenMoved = new Set<string>()
        const sameRouteExports = targetExportsBySpecifier.get(sourceSpecifier) ?? new Set<string>()
        for (const [targetSpecifier, symbols] of Object.entries(movedExports)) {
          if (symbols.length === 0) {
            fail(`split route '${sourceSpecifier}' has an empty move to '${targetSpecifier}'`)
          }
          for (const symbol of symbols) {
            if (!baseline.has(symbol)) {
              fail(`split route '${sourceSpecifier}' moves unknown symbol '${symbol}'`)
            }
            if (seenMoved.has(symbol)) {
              fail(`split route '${sourceSpecifier}' moves '${symbol}' more than once`)
            }
            seenMoved.add(symbol)
            metrics.retainedPackageMovedSymbolCount += 1
            if (sameRouteExports.has(symbol)) {
              fail(`split route '${sourceSpecifier}' leaks moved symbol '${symbol}' into its old closure`)
            }
          }
        }
      }
    }
    for (const symbol of baseline) {
      if (targetExports.has(symbol)) continue
      metrics.retainedPackageTargetMissingSymbolCount += 1
      missingInventory.push(`${sourceSpecifier}:${symbol}`)
    }
    missingByEntrypoint.set(
      sourceSpecifier,
      [...baseline].filter(symbol => !targetExports.has(symbol)).length,
    )
  }
  if (metrics.retainedPackageApiBaselineSymbolCount !== targetAudit.expectedBaselineSymbolCount) {
    fail(`retained non-core/provider API baseline accounting drifted: ${metrics.retainedPackageApiBaselineSymbolCount}`)
  }
  if (metrics.retainedPackageMovedSymbolCount !== 53) {
    fail(`retained package moved-export accounting drifted: ${metrics.retainedPackageMovedSymbolCount}`)
  }
  if (metrics.retainedPackageTargetMissingSymbolCount !== targetAudit.expectedMissingSymbolCount) {
    fail(`retained package target missing count drifted: ${metrics.retainedPackageTargetMissingSymbolCount}`)
  }
  const missingSha256 = createHash('sha256')
    .update(missingInventory.sort().join('\n'))
    .digest('hex')
  if (missingSha256 !== targetAudit.expectedMissingSha256) {
    fail(`retained package target missing hash drifted: ${missingSha256}`)
  }
  assertSameSet(
    'retained package target missing counts by entrypoint',
    new Set([...missingByEntrypoint].map(([specifier, count]) => `${specifier}=${count}`)),
    new Set(Object.entries(targetAudit.expectedMissingByEntrypoint)
      .map(([specifier, count]) => `${specifier}=${count}`)),
  )
}
// @ts-nocheck
