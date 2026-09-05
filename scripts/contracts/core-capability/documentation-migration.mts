// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateDocumentationMigrationBaseline(ctx: ContractContext): void {
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

  const policy = documentationMigration.policy
  if (policy.implementationSlice !== 'I6'
    || policy.facadeDeletionSlice !== 'I7'
    || JSON.stringify(policy.scanRoots) !== JSON.stringify(['README.md', 'docs', 'packages', 'test-human'])
    || policy.surface !== 'fenced-code-inline-code-and-install-command'
    || policy.pendingInventory !== 'exact'
    || policy.newRemovedPackageExamples !== 'forbidden'
    || JSON.stringify(policy.stateOrder) !== JSON.stringify(['pending', 'active-guides-migrated', 'complete'])
    || policy.targetRewriteFiles !== 'zero-removed-package-examples-from-I6'
    || policy.humanJourneyCoupling !== 'all-target-achieved-at-I6'
    || policy.retiredPackageReadmes !== 'present-through-I6-deleted-with-package-at-I7'
    || policy.historicalRecords !== 'may-name-removed-packages-with-explicit-status'
    || policy.targetPackageReadmes !== 'core-plus-all-recommended-composition-entrypoints') {
    fail('documentation migration policy drifted')
  }

  assertSameSet(
    'documentation removed-package routes',
    new Set(Object.keys(documentationMigration.removedPackages)),
    new Set(topology.forbiddenPackages),
  )
  const expectedReplacementRoutes = new Set([
    '@ai-agent-sdk/agent|@ai-agent-sdk/agent=>@ai-agent-sdk/core/agent',
    '@ai-agent-sdk/agent|@ai-agent-sdk/agent/skill-validation=>@ai-agent-sdk/core/skills',
    '@ai-agent-sdk/observability|@ai-agent-sdk/observability=>@ai-agent-sdk/core/observability',
    '@ai-agent-sdk/observability|@ai-agent-sdk/observability/processors=>@ai-agent-sdk/core/observability',
    '@ai-agent-sdk/node|@ai-agent-sdk/node=>explicit-capability-selection',
    '@ai-agent-sdk/node|@ai-agent-sdk/node/env=>@ai-agent-sdk/auth-node/env',
    '@ai-agent-sdk/node|@ai-agent-sdk/node/filesystem=>@ai-agent-sdk/skill-filesystem',
    '@ai-agent-sdk/node|@ai-agent-sdk/node/observability=>@ai-agent-sdk/observability-node',
    'ai-agent-sdk|ai-agent-sdk=>@ai-agent-sdk/core',
    'ai-agent-sdk|ai-agent-sdk/a2a-client=>@ai-agent-sdk/a2a/client',
    'ai-agent-sdk|ai-agent-sdk/a2a-server=>@ai-agent-sdk/a2a/server',
    'ai-agent-sdk|ai-agent-sdk/anthropic=>@ai-agent-sdk/provider-anthropic',
    'ai-agent-sdk|ai-agent-sdk/codex=>@ai-agent-sdk/provider-codex',
    'ai-agent-sdk|ai-agent-sdk/mcp-client=>@ai-agent-sdk/mcp/client',
    'ai-agent-sdk|ai-agent-sdk/mcp-node=>@ai-agent-sdk/mcp-node',
    'ai-agent-sdk|ai-agent-sdk/node=>explicit-capability-selection',
    'ai-agent-sdk|ai-agent-sdk/openai=>@ai-agent-sdk/provider-openai',
    'ai-agent-sdk|ai-agent-sdk/request-logger=>@ai-agent-sdk/observability-node/diagnostic',
    'ai-agent-sdk|ai-agent-sdk/skill-filesystem=>@ai-agent-sdk/skill-filesystem',
  ])
  assertSameSet(
    'documentation exact replacement routes',
    new Set(Object.entries(documentationMigration.removedPackages).flatMap(([removedPackage, rule]) =>
      Object.entries(rule.replacementRoutes).map(([current, target]) =>
        `${removedPackage}|${current}=>${target ?? 'explicit-capability-selection'}`))),
    expectedReplacementRoutes,
  )
  const dispositionEntries = Object.entries(documentationMigration.fileDispositions)
    .flatMap(([disposition, files]) => files.map(file => `${file}=>${disposition}`))
  const dispositionFiles = dispositionEntries.map(entry => entry.slice(0, entry.indexOf('=>')))
  if (new Set(dispositionFiles).size !== dispositionFiles.length) {
    fail('documentation migration assigns one file to more than one disposition')
  }
  assertSameSet(
    'documentation retired package READMEs',
    new Set(documentationMigration.fileDispositions.deleteWithPackage),
    new Set([
      'packages/agent/README.md',
      'packages/node/README.md',
      'packages/observability/README.md',
      'packages/sdk/README.md',
    ]),
  )
  assertSameSet(
    'documentation superseded current designs',
    new Set(documentationMigration.fileDispositions.supersededCurrentDesign),
    new Set([
      'docs/implementation-todo.md',
      'docs/monorepo-implementation-design.md',
      'docs/monorepo-package-architecture.md',
      'docs/observability-implementation-design.md',
    ]),
  )
  assertSameSet(
    'documentation retained migration records',
    new Set(documentationMigration.fileDispositions.retainedMigrationRecord),
    new Set([
      'docs/adr/0002-core-capability-package-and-api-contract.md',
      'docs/core-capability-audit.md',
      'docs/core-capability-composition-design.md',
      'docs/core-capability-human-acceptance-design.md',
      'docs/core-capability-implementation-todo.md',
      'docs/core-capability-package-plan.md',
      'docs/public-api-baseline.md',
    ]),
  )

  const markdownFiles = policy.scanRoots.flatMap(root => {
    const path = join(workspace, root)
    return root.endsWith('.md') ? [path] : listFiles(path, '.md')
  })
  const exampleSpecifiersByFile = new Map(
    markdownFiles.map(file => [relative(file), markdownExampleSpecifiers(file)] as const),
  )
  const actualRemovedFiles = new Set<string>()
  const expectedRemovedFiles = new Set<string>()
  for (const [removedPackage, inventory] of Object.entries(documentationMigration.removedPackages)) {
    if (new Set(inventory.expectedExampleFiles).size !== inventory.expectedExampleFiles.length) {
      fail(`documentation inventory '${removedPackage}' repeats an example file`)
    }
    const actualFiles = new Set(
      [...exampleSpecifiersByFile.entries()]
        .filter(([, specifiers]) => specifiers.some(specifier =>
          specifier === removedPackage || specifier.startsWith(`${removedPackage}/`)))
        .map(([file]) => file),
    )
    for (const file of actualFiles) actualRemovedFiles.add(file)
    for (const file of inventory.expectedExampleFiles) expectedRemovedFiles.add(file)
    const actualSpecifiers = new Set(
      [...exampleSpecifiersByFile.values()].flat().filter(specifier =>
        specifier === removedPackage || specifier.startsWith(`${removedPackage}/`)),
    )
    if (documentationMigration.state === 'pending') {
      assertSameSet(
        `documentation '${removedPackage}' pending example files`,
        actualFiles,
        new Set(inventory.expectedExampleFiles),
      )
      assertSameSet(
        `documentation '${removedPackage}' pending example routes`,
        actualSpecifiers,
        new Set(Object.keys(inventory.replacementRoutes)),
      )
    }
    for (const [currentSpecifier, targetSpecifier] of Object.entries(inventory.replacementRoutes)) {
      if (currentSpecifier !== removedPackage && !currentSpecifier.startsWith(`${removedPackage}/`)) {
        fail(`documentation route '${currentSpecifier}' is not owned by '${removedPackage}'`)
      }
      if (targetSpecifier !== null && !packageBySpecifier.has(targetSpecifier)) {
        fail(`documentation replacement '${currentSpecifier}' -> '${targetSpecifier}' is not a target route`)
      }
    }
  }
  assertSameSet(
    'documentation migration classified files',
    new Set(dispositionFiles),
    expectedRemovedFiles,
  )

  if (documentationMigration.state === 'pending') return

  const allowedHistoricalFiles = new Set([
    ...documentationMigration.fileDispositions.supersededCurrentDesign,
    ...documentationMigration.fileDispositions.retainedMigrationRecord,
    ...(documentationMigration.state === 'active-guides-migrated'
      ? documentationMigration.fileDispositions.deleteWithPackage
      : []),
  ])
  for (const file of actualRemovedFiles) {
    if (!allowedHistoricalFiles.has(file)) {
      fail(`migrated documentation still recommends a removed package in '${file}'`)
    }
  }
  for (const file of documentationMigration.fileDispositions.rewrite) {
    if (!existsSync(join(workspace, file))) fail(`rewritten documentation '${file}' is missing`)
  }
  for (const file of documentationMigration.fileDispositions.deleteWithPackage) {
    const present = existsSync(join(workspace, file))
    if (documentationMigration.state === 'active-guides-migrated' && !present) {
      fail(`I6 documentation state lost pre-I7 package README '${file}'`)
    }
    if (documentationMigration.state === 'complete' && present) {
      fail(`I7-complete documentation still contains retired package README '${file}'`)
    }
  }
  for (const file of documentationMigration.fileDispositions.supersededCurrentDesign) {
    const text = readFileSync(join(workspace, file), 'utf8').slice(0, 800)
    if (!/Status:[^\n]*(?:historical|superseded)/i.test(text)) {
      fail(`superseded design '${file}' lacks an explicit historical/superseded status`)
    }
  }

  const humanTopology = JSON.parse(
    readFileSync(join(workspace, 'test-human/package-topology.json'), 'utf8'),
  ) as { readonly journeys?: readonly { readonly id?: string; readonly status?: string }[] }
  const incompleteHumanJourneys = (humanTopology.journeys ?? [])
    .filter(journey => journey.status !== 'target-achieved')
    .map(journey => journey.id ?? '(unnamed)')
  if (incompleteHumanJourneys.length > 0) {
    fail(`I6 documentation state precedes target human journeys: ${incompleteHumanJourneys.join(', ')}`)
  }

  const coreReadme = readFileSync(join(workspace, 'packages/core/README.md'), 'utf8')
  for (const symbol of documentationMigration.targetCoreReadmeSymbols) {
    if (!coreReadme.includes(symbol)) fail(`target core README does not document '${symbol}'`)
  }
  for (const [packageName, entry] of Object.entries(topology.recommendedCompositionEntrypoints)) {
    const rule = topology.packages[packageName]
    if (rule === undefined) fail(`recommended README package '${packageName}' is absent from topology`)
    const readmePath = join(workspace, 'packages', rule.declarationDir, 'README.md')
    if (!existsSync(readmePath)) fail(`target package README '${relative(readmePath)}' is missing`)
    const readme = readFileSync(readmePath, 'utf8')
    const exampleSpecifiers = new Set(markdownExampleSpecifiers(readmePath))
    if (!readme.includes(entry.symbol) || !exampleSpecifiers.has(entry.specifier)) {
      fail(`target package README '${relative(readmePath)}' lacks recommended import ${entry.symbol} from ${entry.specifier}`)
    }
    if (!readme.includes(entry.compositionPoint) || !readme.includes(entry.lifecycle)) {
      fail(`target package README '${relative(readmePath)}' lacks composition/lifecycle ownership metadata`)
    }
    if (!readme.includes('pnpm add') || !readme.includes(packageName)) {
      fail(`target package README '${relative(readmePath)}' lacks its install command`)
    }
  }
}
// @ts-nocheck
