// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'
// @ts-nocheck

export function validateSourceMigrationBaseline(ctx: ContractContext): void {
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

  const policy = sourceMigration.policy
  if (policy.state !== 'phase-tracked'
    || policy.moveNotCopy !== true
    || policy.preserveRelativePaths !== true
    || policy.eliminateMovedSelfPackageImports !== true
    || policy.bridgeImplementation !== 're-export-only'
    || policy.bridgeManifest !== 'private-esm-side-effect-free-core-only-runtime-dependency'
    || policy.newBridgeConsumers !== 'forbidden'
    || policy.partialCrossRootOwnership !== 'forbidden') {
    fail('source-migration ownership policy drifted')
  }
  const expectedRoots = new Map([
    ['observability', {
      implementationSlice: 'I1',
      sourcePackage: '@ai-agent-sdk/observability',
      sourceRoot: 'packages/observability/src',
      targetRoot: 'packages/core/src/observability',
      packageManifest: 'packages/observability/package.json',
      deletionSlice: 'I7',
      bridgeEntrypoints: {
        '.': {
          sourceFile: 'index.ts',
          canonicalTarget: '@ai-agent-sdk/core/observability',
          emittedBase: 'index',
        },
      },
      fileCount: 7,
      fileListSha256: 'a099dd14a1379b3719fa06c6c4359b109ca9fcd8d3116e43cb385a0c8789811a',
      selfCoreImportFileCount: 6,
      selfCoreImportFileListSha256: 'b44f27883b394fb91521c2e52a0a95021736aad471618fc33c1303abfe19eb5d',
      dependencyFirstGroups: ['(root)'],
    }],
    ['agent', {
      implementationSlice: 'I2',
      sourcePackage: '@ai-agent-sdk/agent',
      sourceRoot: 'packages/agent/src',
      targetRoot: 'packages/core/src/agent',
      packageManifest: 'packages/agent/package.json',
      deletionSlice: 'I7',
      bridgeEntrypoints: {
        '.': {
          sourceFile: 'index.ts',
          canonicalTarget: '@ai-agent-sdk/core/agent',
          emittedBase: 'index',
        },
        './skill-validation': {
          sourceFile: 'skill/validation-export.ts',
          canonicalTarget: '@ai-agent-sdk/core/skills',
          emittedBase: 'skill-validation',
        },
      },
      fileCount: 49,
      fileListSha256: 'ab42f8268c219f1e0ae0a19383b5be711ebd79041a6beaf83d2505c3ed235212',
      selfCoreImportFileCount: 31,
      selfCoreImportFileListSha256: '9dc2e4371732cc10017c9f79ab0fbe86d8bcad2196a37c0e256445bd76151f52',
      dependencyFirstGroups: [
        'tool',
        'history',
        'trace',
        'accounting',
        'loop',
        'mode',
        'skill',
        'memory',
        'define',
        'team',
        'a2a',
        '(root)',
      ],
    }],
  ] as const)
  if (JSON.stringify(policy.migrationOrder) !== JSON.stringify([...expectedRoots.keys()])) {
    fail('source-migration slice order must remain observability I1 then agent I2')
  }
  assertSameSet(
    'source-migration roots',
    new Set(Object.keys(sourceMigration.roots)),
    new Set(expectedRoots.keys()),
  )

  for (const [rootId, expected] of expectedRoots) {
    const migration = sourceMigration.roots[rootId]
    if (migration === undefined) fail(`source-migration root '${rootId}' is missing`)
    if (migration.implementationSlice !== expected.implementationSlice
      || migration.sourcePackage !== expected.sourcePackage
      || migration.sourceRoot !== expected.sourceRoot
      || migration.targetRoot !== expected.targetRoot
      || migration.packageManifest !== expected.packageManifest
      || migration.deletionSlice !== expected.deletionSlice
      || JSON.stringify(migration.bridgeEntrypoints) !== JSON.stringify(expected.bridgeEntrypoints)
      || migration.fileCount !== expected.fileCount
      || migration.fileListSha256 !== expected.fileListSha256
      || migration.selfCoreImportFileCount !== expected.selfCoreImportFileCount
      || migration.selfCoreImportFileListSha256 !== expected.selfCoreImportFileListSha256
      || JSON.stringify(migration.dependencyFirstGroups) !== JSON.stringify(expected.dependencyFirstGroups)) {
      fail(`source-migration root '${rootId}' ownership route drifted`)
    }
    const sourceRoot = join(workspace, migration.sourceRoot)
    const targetRoot = join(workspace, migration.targetRoot)
    const removalInventory = topology.removalMigrationInventory[migration.sourcePackage]
    const expectedReplacementSpecifiers = new Map(
      Object.entries(migration.bridgeEntrypoints).map(([route, entrypoint]) => [
        route === '.' ? migration.sourcePackage : `${migration.sourcePackage}${route.slice(1)}`,
        entrypoint.canonicalTarget,
      ]),
    )
    assertSameSet(
      `source-migration root '${rootId}' bridge consumer replacements`,
      new Set(Object.entries(removalInventory?.replacementSpecifiers ?? {}).map(([from, to]) => `${from}=>${to}`)),
      new Set([...expectedReplacementSpecifiers].map(([from, to]) => `${from}=>${to}`)),
    )
    const packageManifestPath = join(workspace, migration.packageManifest)
    const baselineFiles = [...migration.files].sort()
    if (new Set(baselineFiles).size !== baselineFiles.length
      || baselineFiles.some(file => file.startsWith('/') || file.includes('..'))) {
      fail(`source-migration root '${rootId}' has invalid baseline paths`)
    }
    const baselineHash = createHash('sha256').update(baselineFiles.join('\n')).digest('hex')
    if (baselineFiles.length !== migration.fileCount || baselineHash !== migration.fileListSha256) {
      fail(`source-migration root '${rootId}' frozen file list drifted`)
    }
    if (new Set(migration.dependencyFirstGroups).size !== migration.dependencyFirstGroups.length) {
      fail(`source-migration root '${rootId}' repeats a dependency-first group`)
    }
    if (migration.state === 'deleted') {
      if (existsSync(sourceRoot) || existsSync(packageManifestPath)) {
        fail(`I7-deleted source-migration root '${rootId}' still has a bridge package`)
      }
      for (const file of baselineFiles) {
        if (!existsSync(join(targetRoot, file))) {
          fail(`deleted bridge source '${rootId}/${file}' is missing from its canonical target`)
        }
      }
      for (const target of listFiles(targetRoot, '.ts')) {
        const lineCount = readFileSync(target, 'utf8').trimEnd().split('\n').length
        if (lineCount > 700) {
          fail(`moved source '${relative(target)}' exceeds the 700-line implementation limit (${lineCount})`)
        }
        if (importsOf(target).some(specifier =>
          specifier === '@ai-agent-sdk/core' || specifier.startsWith('@ai-agent-sdk/core/')
          || specifier === migration.sourcePackage || specifier.startsWith(`${migration.sourcePackage}/`))) {
          fail(`canonical source root '${rootId}' retains a self/deleted-bridge import in ${relative(target)}`)
        }
      }
      continue
    }
    const bridgeManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')) as {
      readonly name?: string
      readonly private?: boolean
      readonly type?: string
      readonly sideEffects?: boolean
      readonly main?: string
      readonly types?: string
      readonly dependencies?: Readonly<Record<string, string>>
      readonly peerDependencies?: Readonly<Record<string, string>>
      readonly optionalDependencies?: Readonly<Record<string, string>>
      readonly exports?: Readonly<Record<string, unknown>>
    }
    if (bridgeManifest.name !== migration.sourcePackage
      || bridgeManifest.private !== true
      || bridgeManifest.type !== 'module'
      || bridgeManifest.sideEffects !== false) {
      fail(`source-migration root '${rootId}' bridge manifest identity drifted`)
    }
    assertSameSet(
      `source-migration root '${rootId}' bridge runtime dependencies`,
      new Set(Object.entries(bridgeManifest.dependencies ?? {}).map(([name, range]) => `${name}=${range}`)),
      new Set(['@ai-agent-sdk/core=workspace:^']),
    )
    if (Object.keys(bridgeManifest.peerDependencies ?? {}).length > 0
      || Object.keys(bridgeManifest.optionalDependencies ?? {}).length > 0) {
      fail(`source-migration root '${rootId}' bridge manifest adds peer or optional dependencies`)
    }
    if (migration.state === 'pending') {
      const sourceFiles = [...listFiles(sourceRoot, '.ts')]
      const relativeFiles = sourceFiles
        .map(file => file.slice(sourceRoot.length + 1).replaceAll('\\', '/'))
        .sort()
      assertSameSet(
        `source-migration root '${rootId}' pending files`,
        new Set(relativeFiles),
        new Set(baselineFiles),
      )
      const selfCoreImportFiles = sourceFiles
        .filter(file => importsOf(file).some(specifier =>
          specifier === '@ai-agent-sdk/core' || specifier.startsWith('@ai-agent-sdk/core/')))
        .map(file => file.slice(sourceRoot.length + 1).replaceAll('\\', '/'))
        .sort()
      const selfCoreImportHash = createHash('sha256')
        .update(selfCoreImportFiles.join('\n'))
        .digest('hex')
      if (selfCoreImportFiles.length !== migration.selfCoreImportFileCount
        || selfCoreImportHash !== migration.selfCoreImportFileListSha256) {
        fail(`source-migration root '${rootId}' self-core import inventory drifted`)
      }
      for (const file of sourceFiles) {
        if (importsOf(file).some(specifier =>
          specifier === migration.sourcePackage || specifier.startsWith(`${migration.sourcePackage}/`))) {
          fail(`source-migration root '${rootId}' contains a self-package import in ${relative(file)}`)
        }
      }
      const graph = analyzeSourceOwnershipGraph(sourceRoot)
      if (graph.cycles.length > 0) fail(`source-migration root '${rootId}' is cyclic before migration`)
      assertSameSet(
        `source-migration root '${rootId}' dependency-first groups`,
        new Set(migration.dependencyFirstGroups),
        new Set(Object.keys(graph.dependenciesByGroup)),
      )
      const position = new Map(
        migration.dependencyFirstGroups.map((group, index) => [group, index]),
      )
      for (const [consumer, dependencies] of Object.entries(graph.dependenciesByGroup)) {
        for (const dependency of dependencies) {
          if ((position.get(dependency) ?? Number.POSITIVE_INFINITY)
            >= (position.get(consumer) ?? Number.NEGATIVE_INFINITY)) {
            fail(`source-migration root '${rootId}' orders '${consumer}' before dependency '${dependency}'`)
          }
        }
      }
      const collisions = new Set(
        relativeFiles.filter(file => existsSync(join(targetRoot, file))),
      )
      assertSameSet(
        `source-migration root '${rootId}' target collisions`,
        collisions,
        new Set(Object.keys(migration.targetCollisions)),
      )
    } else {
      for (const file of baselineFiles) {
        const target = join(targetRoot, file)
        if (!existsSync(target)) fail(`moved source '${rootId}/${file}' is missing from its target`)
      }
      for (const target of listFiles(targetRoot, '.ts')) {
        const lineCount = readFileSync(target, 'utf8').trimEnd().split('\n').length
        if (lineCount > 700) {
          fail(`moved source '${relative(target)}' exceeds the 700-line implementation limit (${lineCount})`)
        }
        if (importsOf(target).some(specifier =>
          specifier === '@ai-agent-sdk/core' || specifier.startsWith('@ai-agent-sdk/core/')
          || specifier === migration.sourcePackage || specifier.startsWith(`${migration.sourcePackage}/`))) {
          fail(`moved source root '${rootId}' retains a self/bridge package import in ${relative(target)}`)
        }
      }
      const bridgeFiles = [...listFiles(sourceRoot, '.ts')]
      const bridgeRelativeFiles = bridgeFiles.map(file =>
        file.slice(sourceRoot.length + 1).replaceAll('\\', '/'))
      assertSameSet(
        `source-migration root '${rootId}' bridge files`,
        new Set(bridgeRelativeFiles),
        new Set(Object.values(migration.bridgeEntrypoints).map(entrypoint => entrypoint.sourceFile)),
      )
      for (const [route, entrypoint] of Object.entries(migration.bridgeEntrypoints)) {
        const bridgeFile = join(sourceRoot, entrypoint.sourceFile)
        const bridgeSource = readFileSync(bridgeFile, 'utf8')
        assertSameSet(
          `source-migration root '${rootId}' bridge '${route}' imports`,
          new Set(importsOf(bridgeFile)),
          new Set([entrypoint.canonicalTarget]),
        )
        if (!bridgeSource.includes(`export * from '${entrypoint.canonicalTarget}'`)
          || /\b(?:class|function|const|let|interface|type)\s+[A-Za-z_$]/.test(bridgeSource)) {
          fail(`source-migration root '${rootId}' bridge '${route}' contains implementation or declarations`)
        }
      }
      const expectedBridgeRoutes = new Set([
        ...Object.keys(migration.bridgeEntrypoints),
        './package.json',
      ])
      assertSameSet(
        `source-migration root '${rootId}' bridge manifest routes`,
        new Set(Object.keys(bridgeManifest.exports ?? {})),
        expectedBridgeRoutes,
      )
      for (const [route, entrypoint] of Object.entries(migration.bridgeEntrypoints)) {
        const manifestTarget = bridgeManifest.exports?.[route]
        if (typeof manifestTarget !== 'object' || manifestTarget === null) {
          fail(`source-migration root '${rootId}' bridge manifest route '${route}' is invalid`)
        }
        const conditions = manifestTarget as Readonly<Record<string, string>>
        assertSameSet(
          `source-migration root '${rootId}' bridge manifest route '${route}' conditions`,
          new Set(Object.keys(conditions)),
          new Set(['types', 'import', 'default']),
        )
        const output = `./dist/${entrypoint.emittedBase}.js`
        if (conditions.types !== `./dist/${entrypoint.emittedBase}.d.ts`
          || conditions.import !== output
          || conditions.default !== output) {
          fail(`source-migration root '${rootId}' bridge manifest route '${route}' output drifted`)
        }
      }
      if (bridgeManifest.exports?.['./package.json'] !== './package.json'
        || bridgeManifest.main !== './dist/index.js'
        || bridgeManifest.types !== './dist/index.d.ts') {
        fail(`source-migration root '${rootId}' bridge manifest root metadata drifted`)
      }
      const movedGraph = analyzeSourceOwnershipGraph(targetRoot)
      if (movedGraph.cycles.length > 0) fail(`source-migration root '${rootId}' target is cyclic`)
    }
    for (const action of Object.values(migration.targetCollisions)) {
      if (action !== 'merge-exports-into-existing-target-then-delete-source') {
        fail(`source-migration root '${rootId}' has an unsupported collision action`)
      }
    }
  }

  let pendingSeen = false
  for (const rootId of policy.migrationOrder) {
    const state = sourceMigration.roots[rootId]?.state
    if (state === 'pending') pendingSeen = true
    else if ((state === 'moved' || state === 'deleted') && pendingSeen) {
      fail(`source-migration root '${rootId}' moved before an earlier ownership slice`)
    }
  }
}
