// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import { assertSharedDeclarationImport, migrationDeclarationView } from '../migration-api.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateApiMigration(ctx: ContractContext): void {
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
  const targetApiParityPolicy = topology.targetApiParityPolicy
  const tsconfig = JSON.parse(readFileSync(ctx.configPath, 'utf8')) as {
    readonly compilerOptions?: { readonly paths?: Readonly<Record<string, readonly string[]>> }
  }

  if (apiMigration.policy.defaultAction !== 'preserve') {
    fail('API migration must preserve every baseline symbol unless explicitly removed')
  }
  if (apiMigration.policy.currentCoreRoot !== 'retain-root'
    || apiMigration.policy.movedPackageRoot !== 'assigned-target-subpath'
    || apiMigration.policy.focusedSubpaths !== 'reexport-canonical-only'
    || apiMigration.policy.forbidDuplicateDeclarations !== true) {
    fail('API routing policy must retain core root and use canonical subpath re-exports')
  }
  assertSameSet(
    'API removal evidence requirements',
    new Set(apiMigration.policy.removalRequires),
    new Set([
      'stable-decision-id',
      'replacement-or-rationale',
      'consumer-migration',
      'owner-approval',
    ]),
  )
  assertSameSet(
    'API migration source packages',
    new Set(Object.keys(apiMigration.sources)),
    new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/agent',
      '@ai-agent-sdk/agent/skill-validation',
      '@ai-agent-sdk/observability',
    ]),
  )
  assertSameSet(
    'target API parity inventory sources',
    new Set(Object.keys(targetApiParityPolicy.sources)),
    new Set(Object.keys(apiMigration.sources)),
  )

  const rootPolicy = topology.coreRootFacadePolicy
  if (rootPolicy.canonicalOwnerVisibility !== 'internal-not-package-export'
    || rootPolicy.normalApplicationImports !== 'curated-root'
    || rootPolicy.packageAuthorImports !== 'focused-subpaths') {
    fail('core root facade must separate the internal canonical owner from application and author views')
  }
  const currentCoreBaseline = new Set(
    apiMigration.sources['@ai-agent-sdk/core']?.exports ?? [],
  )
  if (currentCoreBaseline.size !== rootPolicy.currentCoreBaselineCount) {
    fail('curated core root current-baseline count drifted')
  }
  const rootPaths = tsconfig.compilerOptions?.paths?.['@ai-agent-sdk/core']
  if (rootPaths?.length !== 1 || rootPaths[0] !== `./${rootPolicy.publicRootDeclaration}`) {
    fail('the public core specifier must resolve to the curated root facade')
  }
  const rootFile = join(contractRoot, rootPolicy.publicRootDeclaration)
  const canonicalFile = join(contractRoot, rootPolicy.canonicalDeclaration)
  const rootSource = readFileSync(rootFile, 'utf8')
  assertSameSet(
    'curated core root canonical source',
    new Set(importsOf(rootFile)),
    new Set(['./index.js']),
  )
  if (/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|const|function)\s+[A-Za-z_$]/.test(rootSource)) {
    fail('curated core root must re-export canonical declarations rather than own duplicates')
  }
  const rootExports = targetDeclarationExportsOf(rootFile)
  const canonicalExports = targetDeclarationExportsOf(canonicalFile)
  const ergonomicAdditions = new Set(rootPolicy.ergonomicAdditions)
  if (ergonomicAdditions.size !== rootPolicy.ergonomicAdditions.length) {
    fail('curated core root contains duplicate ergonomic additions')
  }
  for (const symbol of ergonomicAdditions) {
    if (currentCoreBaseline.has(symbol)) {
      fail(`curated core root ergonomic addition '${symbol}' is already in the current core baseline`)
    }
    if (!canonicalExports.has(symbol)) {
      fail(`curated core root ergonomic addition '${symbol}' has no canonical declaration`)
    }
  }
  const expectedRootExports = new Set([...currentCoreBaseline, ...ergonomicAdditions])
  assertSameSet('curated core root exports', rootExports, expectedRootExports)
  if (rootExports.size !== rootPolicy.expectedRootExportCount) {
    fail(`curated core root export count drifted: ${rootExports.size}`)
  }
  for (const symbol of rootExports) {
    if (!canonicalExports.has(symbol)) {
      fail(`curated core root export '${symbol}' has no canonical declaration`)
    }
  }
  for (const [packageName, rule] of Object.entries(topology.packages)) {
    if (packageName === '@ai-agent-sdk/core') continue
    const directory = join(contractRoot, 'packages', rule.declarationDir)
    for (const file of listFiles(directory, '.d.ts')) {
      if (importsOf(file).includes('@ai-agent-sdk/core')) {
        fail(`package-author declaration '${relative(file)}' must use a focused core subpath`)
      }
    }
  }

  const decisions = new Set(phase0.decisions.map(decision => decision.id))
  const sourcesBySymbol = new Map<string, Set<string>>()
  for (const [sourcePackage, source] of Object.entries(apiMigration.sources)) {
    if (!packageBySpecifier.has(source.targetSpecifier)) {
      fail(`API migration '${sourcePackage}' targets unknown specifier '${source.targetSpecifier}'`)
    }
    const baseline = new Set(source.exports)
    if (baseline.size !== source.exports.length) {
      fail(`API migration '${sourcePackage}' contains duplicate baseline symbols`)
    }
    const declarationPath = join(workspace, source.declaration)
    const declarationText = existsSync(declarationPath) ? readFileSync(declarationPath, 'utf8') : undefined
    const declarationHash = declarationText === undefined
      ? undefined
      : createHash('sha256').update(declarationText).digest('hex')
    const removed = new Set<string>()
    for (const removal of source.remove) {
      if (!baseline.has(removal.symbol)) {
        fail(`API removal '${sourcePackage}.${removal.symbol}' is not in its baseline`)
      }
      if (removed.has(removal.symbol)) {
        fail(`duplicate API removal '${sourcePackage}.${removal.symbol}'`)
      }
      removed.add(removal.symbol)
      metrics.apiProposedRemovalCount++
      if (!decisions.has(removal.decisionId)) {
        fail(`API removal '${sourcePackage}.${removal.symbol}' names unknown '${removal.decisionId}'`)
      }
      if (removal.replacement.trim().length === 0 || removal.consumerMigration.trim().length === 0) {
        fail(`API removal '${sourcePackage}.${removal.symbol}' lacks replacement/migration guidance`)
      }
    }
    const migratedView = migrationDeclarationView(workspace, sourcePackage, declarationPath, source.declarationSha256)
    if (migratedView === undefined && declarationHash !== source.declarationSha256) {
      fail(`API declaration signature baseline drifted for '${sourcePackage}'`)
    }
    const currentPath = migratedView ?? declarationPath
    if (!existsSync(currentPath)) fail(`API declaration view is missing for '${sourcePackage}'`)
    const current = publicExportsOf(currentPath)
    if (migratedView === undefined) {
      assertSameSet(`API baseline for '${sourcePackage}'`, current, baseline)
    } else {
      const missingCurrent = [...baseline]
        .filter(symbol => !removed.has(symbol) && !current.has(symbol))
        .sort()
      if (missingCurrent.length > 0) {
        fail(`migrated API baseline for '${sourcePackage}' is missing [${missingCurrent.join(', ')}]`)
      }
    }
    metrics.apiBaselineSymbolCount += baseline.size
    for (const symbol of baseline) {
      const sources = sourcesBySymbol.get(symbol) ?? new Set<string>()
      sources.add(sourcePackage)
      sourcesBySymbol.set(symbol, sources)
    }

    const parityRule = targetApiParityPolicy.sources[sourcePackage]
    if (parityRule === undefined || parityRule.targetSpecifier !== source.targetSpecifier) {
      fail(`target API parity route drifted for '${sourcePackage}'`)
    }
    const targetPaths = tsconfig.compilerOptions?.paths?.[source.targetSpecifier]
    if (targetPaths?.length !== 1 || targetPaths[0] === undefined) {
      fail(`target API parity '${sourcePackage}' has no unique declaration path`)
    }
    const targetExports = targetDeclarationExportsOf(resolve(contractRoot, targetPaths[0]))
    if (sourcePackage === '@ai-agent-sdk/core') {
      const restoredCoreSymbols = new Set([
        ...topology.coreMessageCompatibilityPolicy.coveredSymbols,
        ...topology.coreProviderCompatibilityPolicy.coveredSymbols,
      ])
      if (restoredCoreSymbols.size !== 112) {
        fail('core compatibility policies must cover the exact 112-name restored inventory')
      }
      for (const symbol of [
        ...restoredCoreSymbols,
        ...topology.coreProviderCompatibilityPolicy.signatureSensitiveExistingSymbols,
      ]) {
        if (!baseline.has(symbol) || !targetExports.has(symbol)) {
          fail(`core compatibility policy symbol '${symbol}' is not preserved at both baseline and target`)
        }
      }
    }
    if (sourcePackage === '@ai-agent-sdk/agent') {
      for (const symbol of [
        ...topology.agentToolCompatibilityPolicy.coveredSymbols,
        ...topology.agentToolCompatibilityPolicy.signatureSensitiveExistingSymbols,
        ...topology.agentSkillCompatibilityPolicy.coveredSymbols,
        ...topology.agentSkillCompatibilityPolicy.signatureSensitiveExistingSymbols,
        ...topology.agentMemoryHistoryCompatibilityPolicy.coveredSymbols,
        ...topology.agentMemoryHistoryCompatibilityPolicy.signatureSensitiveExistingSymbols,
        ...topology.agentAccountingTraceCompatibilityPolicy.coveredSymbols,
        ...topology.agentAccountingTraceCompatibilityPolicy.signatureSensitiveExistingSymbols,
        ...topology.agentLoopDefinitionCompatibilityPolicy.coveredSymbols,
        ...topology.agentLoopDefinitionCompatibilityPolicy.signatureSensitiveExistingSymbols,
        ...topology.agentTeamCompatibilityPolicy.coveredSymbols,
        ...topology.agentTeamCompatibilityPolicy.signatureSensitiveExistingSymbols,
      ]) {
        if (!baseline.has(symbol) || !targetExports.has(symbol)) {
          fail(`agent tool compatibility policy symbol '${symbol}' is not preserved at both baseline and target`)
        }
      }
    }
    const missing = [...baseline]
      .filter(symbol => !removed.has(symbol) && !targetExports.has(symbol))
      .sort()
    const missingSha256 = createHash('sha256').update(missing.join('\n')).digest('hex')
    if (missing.length !== parityRule.missingCount
      || missingSha256 !== parityRule.missingSha256) {
      fail(`target API parity inventory drifted for '${sourcePackage}': ${missing.length} missing, ${missingSha256}`)
    }
    metrics.targetApiMissingSymbolCount += missing.length
  }
  if (metrics.apiBaselineSymbolCount !== 417 || metrics.apiProposedRemovalCount !== 1) {
    fail(`API migration accounting drifted: ${metrics.apiBaselineSymbolCount} symbols, ${metrics.apiProposedRemovalCount} removals`)
  }
  if (phase0.overallStatus === 'approved' && metrics.targetApiMissingSymbolCount !== 0) {
    fail(`Phase 0 cannot be approved with ${metrics.targetApiMissingSymbolCount} target API parity symbol(s) missing`)
  }

  const actualCollisions = new Map(
    [...sourcesBySymbol.entries()].filter(([, sources]) => sources.size > 1),
  )
  assertSameSet(
    'API collision inventory',
    new Set(actualCollisions.keys()),
    new Set(apiMigration.canonicalCollisions.map(collision => collision.symbol)),
  )
  for (const collision of apiMigration.canonicalCollisions) {
    const sources = actualCollisions.get(collision.symbol)
    if (sources === undefined) fail(`API collision '${collision.symbol}' is not present`)
    assertSameSet(
      `API collision '${collision.symbol}' sources`,
      sources,
      new Set(collision.sourcePackages),
    )
    if (!packageBySpecifier.has(collision.canonicalSpecifier)) {
      fail(`API collision '${collision.symbol}' has unknown canonical specifier`)
    }
    for (const specifier of collision.reexportSpecifiers) {
      if (!packageBySpecifier.has(specifier)) {
        fail(`API collision '${collision.symbol}' has unknown re-export specifier '${specifier}'`)
      }
    }
  }
  if (sourceMigration.roots.agent?.state !== 'pending') {
    assertSharedDeclarationImport(
      join(workspace, 'packages/core/dist/index.d.ts'),
      join(workspace, 'packages/core/dist/agent.d.ts'),
      'AgentMessageSource',
    )
  } else {
    const currentAgentDeclaration = readFileSync(
      join(workspace, apiMigration.sources['@ai-agent-sdk/agent']?.declaration ?? ''),
      'utf8',
    )
    if (!/import\s*\{[^}]*AgentMessageSource[^}]*\}\s*from\s*["']@ai-agent-sdk\/core["']/.test(currentAgentDeclaration)
      || /^(?:(?:declare\s+)?(?:interface|class)\s+AgentMessageSource\b|(?:declare\s+)?type\s+AgentMessageSource\s*=)/m.test(currentAgentDeclaration)) {
      fail('current agent AgentMessageSource must be a canonical core re-export, not a duplicate declaration')
    }
  }

  for (const fileName of [
    'agent.d.ts',
    'memory.d.ts',
    'observability.d.ts',
    'provider.d.ts',
    'skills.d.ts',
    'tools.d.ts',
  ]) {
    const file = join(contractRoot, 'packages/core', fileName)
    const source = readFileSync(file, 'utf8')
    assertSameSet(
      `canonical core subpath sources in '${fileName}'`,
      new Set(importsOf(file)),
      new Set(['./index.js']),
    )
    if (/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|const|function)\s+[A-Za-z_$]/.test(source)) {
      fail(`core subpath '${fileName}' must re-export canonical root declarations only`)
    }
  }
}
// @ts-nocheck
