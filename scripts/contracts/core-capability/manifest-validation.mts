// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateManifestBlueprintContract(ctx: ContractContext): void {
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

  const policy = manifestBlueprints.policy
  if (policy.explicitExportsOnly !== true
    || policy.wildcardExports !== false
    || policy.requireCondition !== false
    || policy.packageJsonExport !== true) {
    fail('manifest blueprints must use explicit ESM-only exports including package.json')
  }
  assertSameSet(
    'manifest blueprint packages',
    new Set(Object.keys(manifestBlueprints.packages)),
    new Set(topology.manifestPolicy.blueprintPackages),
  )
  assertSameSet(
    'required manifest blueprints',
    new Set(topology.manifestPolicy.blueprintPackages),
    new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/provider-http',
      '@ai-agent-sdk/provider-openai',
      '@ai-agent-sdk/provider-anthropic',
      '@ai-agent-sdk/provider-codex',
      '@ai-agent-sdk/protocol-responses',
      '@ai-agent-sdk/protocol-anthropic-messages',
      '@ai-agent-sdk/auth-node',
      '@ai-agent-sdk/a2a',
      '@ai-agent-sdk/mcp',
      '@ai-agent-sdk/mcp-server',
      '@ai-agent-sdk/mcp-node',
      '@ai-agent-sdk/mcp-node-server',
      '@ai-agent-sdk/skill-filesystem',
      '@ai-agent-sdk/observability-fetch',
      '@ai-agent-sdk/observability-browser',
      '@ai-agent-sdk/observability-node',
      '@ai-agent-sdk/observability-otel',
    ]),
  )

  for (const [packageName, blueprint] of Object.entries(manifestBlueprints.packages)) {
    const packageRule = topology.packages[packageName]
    if (packageRule === undefined || packageRule.runtime !== blueprint.runtime) {
      fail(`manifest blueprint '${packageName}' has an unknown or mismatched runtime owner`)
    }
    if (blueprint.canonicalOwnerExported !== false) {
      fail(`manifest blueprint '${packageName}' must not export its canonical internal owner`)
    }
    const expectedRoutes = new Set([
      ...packageRule.specifiers.map(specifier => (
        specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
      )),
      './package.json',
    ])
    assertSameSet(
      `manifest blueprint '${packageName}' export routes`,
      new Set(Object.keys(blueprint.exports)),
      expectedRoutes,
    )
    for (const [route, target] of Object.entries(blueprint.exports)) {
      if (route.includes('*')) fail(`manifest blueprint '${packageName}' contains a wildcard export`)
      if (route === './package.json') {
        if (target !== './package.json') {
          fail(`manifest blueprint '${packageName}' has an invalid package.json export`)
        }
        continue
      }
      if (typeof target === 'string') {
        fail(`manifest blueprint '${packageName}' route '${route}' lacks conditional exports`)
      }
      assertSameSet(
        `manifest blueprint '${packageName}' route '${route}' conditions`,
        new Set(Object.keys(target)),
        new Set(topology.manifestPolicy.requiredExportConditions),
      )
      const outputName = route === '.' ? 'index' : route.slice(2)
      const codeExtension = blueprint.runtime === 'node' ? 'mjs' : 'js'
      const declarationExtension = blueprint.runtime === 'node' ? 'd.mts' : 'd.ts'
      const expectedImport = `./dist/${outputName}.${codeExtension}`
      const expectedTypes = `./dist/${outputName}.${declarationExtension}`
      if (target.import !== expectedImport
        || target.default !== expectedImport
        || target.types !== expectedTypes) {
        fail(`manifest blueprint '${packageName}' route '${route}' has invalid ESM output targets`)
      }
    }

    const optionalPeerRoutes = blueprint.optionalPeerRoutes ?? {}
    const expectedOptionalPeerRoutes = Object.fromEntries(
      Object.entries(packageRule.specifierPeerRequirements ?? {}).map(([specifier, peer]) => [
        `.${specifier.slice(packageName.length)}`,
        peer,
      ]),
    )
    assertSameSet(
      `manifest blueprint '${packageName}' optional peer routes`,
      new Set(Object.entries(optionalPeerRoutes).map(([route, peer]) => `${route}=${peer}`)),
      new Set(Object.entries(expectedOptionalPeerRoutes).map(([route, peer]) => `${route}=${peer}`)),
    )
  }

  const coreBlueprint = manifestBlueprints.packages['@ai-agent-sdk/core']
  if (coreBlueprint?.rootFacadeExportCount !== topology.coreRootFacadePolicy.expectedRootExportCount) {
    fail('core manifest blueprint root facade count drifted')
  }
  const authBlueprint = manifestBlueprints.packages['@ai-agent-sdk/auth-node']
  assertSameSet(
    'auth-node manifest identity routes',
    new Set(authBlueprint?.identityRoutes ?? []),
    new Set(['.', './env']),
  )
  const mcpBlueprint = manifestBlueprints.packages['@ai-agent-sdk/mcp']
  assertSameSet(
    'mcp manifest identity routes',
    new Set(mcpBlueprint?.identityRoutes ?? []),
    new Set(['.', './client']),
  )
  const observabilityNodeBlueprint = manifestBlueprints.packages['@ai-agent-sdk/observability-node']
  assertSameSet(
    'observability-node manifest identity routes',
    new Set(observabilityNodeBlueprint?.identityRoutes ?? []),
    new Set(['.', './journal', './diagnostic']),
  )
}
// @ts-nocheck
