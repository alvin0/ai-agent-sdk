// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'

export function validateManifestAndEvidencePolicies(ctx: ContractContext): void {
  const { workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
  } = ctx
  const {
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
  } = makeHelpers(workspace, topology)
  const { readFileSync, existsSync } = fs
  const { join, resolve } = path
  void [workspace, contractRoot, topology, phase0, apiMigration, providerApiBaseline,
    retainedPackageApiBaseline, manifestBlueprints, installClosures, sourceMigration,
    documentationMigration, packageBySpecifier, declarationDependencies, metrics,
    relative, fail, runtimeRank, assertSameSet, parseImports, importsOf,
    parseTargetDeclarationExports, targetDeclarationExportsOf, publicExportsOf,
    listFiles, listCodeFiles, markdownExampleSpecifiers, externalPackageName,
    packageNameOf, externalImportOwner, externalClosure, workspaceClosure,
    readFileSync, existsSync, join, resolve]
if (topology.schemaVersion !== 5) fail(`unsupported topology schema ${String(topology.schemaVersion)}`)
if (phase0.schemaVersion !== 1) fail(`unsupported Phase 0 schema ${String(phase0.schemaVersion)}`)
if (manifestBlueprints.schemaVersion !== 1) {
  fail(`unsupported manifest blueprint schema ${String(manifestBlueprints.schemaVersion)}`)
}
if (installClosures.schemaVersion !== 1) {
  fail(`unsupported install-closure schema ${String(installClosures.schemaVersion)}`)
}
if (sourceMigration.schemaVersion !== 1) {
  fail(`unsupported source-migration schema ${String(sourceMigration.schemaVersion)}`)
}
if (documentationMigration.schemaVersion !== 1) {
  fail(`unsupported documentation-migration schema ${String(documentationMigration.schemaVersion)}`)
}
if (apiMigration.schemaVersion !== 1) {
  fail(`unsupported API migration schema ${String(apiMigration.schemaVersion)}`)
}
if (providerApiBaseline.schemaVersion !== 1) {
  fail(`unsupported provider API baseline schema ${String(providerApiBaseline.schemaVersion)}`)
}
if (retainedPackageApiBaseline.schemaVersion !== 1) {
  fail(`unsupported retained package API baseline schema ${String(retainedPackageApiBaseline.schemaVersion)}`)
}

if (topology.manifestPolicy.moduleFormat !== 'esm-only'
  || topology.manifestPolicy.type !== 'module'
  || topology.manifestPolicy.sideEffects !== false
  || topology.manifestPolicy.privateUntilPublicationConfigured !== true
  || topology.manifestPolicy.legacyRootFields !== 'mirror-root-import-and-types'
  || topology.manifestPolicy.nodeEngineScope !== 'node-runtime-packages-only'
  || topology.manifestPolicy.includePackageJsonExport !== true
  || topology.manifestPolicy.forbidUndeclaredDeepImports !== true
  || topology.manifestPolicy.blueprint !== 'manifest-blueprints.json'
  || topology.manifestPolicy.corePeerRange !== 'workspace:^'
  || topology.manifestPolicy.nodeEngine !== '>=22.12') {
  fail('target manifest policy drifted from the approved ESM/private/core-peer/runtime contract')
}
assertSameSet(
  'base packed package files',
  new Set(topology.manifestPolicy.basePackedFiles),
  new Set(['dist', 'README.md', 'LICENSE']),
)
assertSameSet(
  'packages with additional packed files',
  new Set(Object.keys(topology.manifestPolicy.additionalPackedFiles)),
  new Set(['@ai-agent-sdk/auth-node']),
)
assertSameSet(
  'auth-node additional packed files',
  new Set(topology.manifestPolicy.additionalPackedFiles['@ai-agent-sdk/auth-node'] ?? []),
  new Set(['bin']),
)
assertSameSet(
  'packages with binary entrypoints',
  new Set(Object.keys(topology.manifestPolicy.binaryEntrypoints)),
  new Set(['@ai-agent-sdk/auth-node']),
)
const authBinaryEntrypoints = topology.manifestPolicy.binaryEntrypoints['@ai-agent-sdk/auth-node']
if (authBinaryEntrypoints?.['ai-agent-sdk-codex-login'] !== './bin/ai-agent-sdk-codex-login.mjs'
  || Object.keys(authBinaryEntrypoints ?? {}).length !== 1) {
  fail('auth-node Codex login binary entrypoint drifted')
}
const currentAuthManifest = JSON.parse(
  readFileSync(join(workspace, 'packages/auth-node/package.json'), 'utf8'),
) as { readonly bin?: Readonly<Record<string, string>> }
assertSameSet(
  'retained auth-node binary entrypoints',
  new Set(Object.entries(currentAuthManifest.bin ?? {}).map(([name, target]) => `${name}=${target}`)),
  new Set(Object.entries(authBinaryEntrypoints ?? {}).map(([name, target]) => `${name}=${target}`)),
)
assertSameSet(
  'required target export conditions',
  new Set(topology.manifestPolicy.requiredExportConditions),
  new Set(['types', 'import', 'default']),
)
assertSameSet(
  'forbidden target export conditions',
  new Set(topology.manifestPolicy.forbiddenExportConditions),
  new Set(['require']),
)
const dependencyEncoding = topology.manifestPolicy.dependencyEncoding
if (dependencyEncoding.normalWorkspaceDependencies !== 'dependencies-workspace-caret'
  || dependencyEncoding.corePeer !== 'peerDependencies-workspace-caret-plus-devDependency'
  || dependencyEncoding.optionalWorkspacePeers !== 'peerDependencies-workspace-caret-plus-peerDependenciesMeta-optional'
  || dependencyEncoding.externalRuntimeDependencies !== 'dependencies-catalog-exact'
  || dependencyEncoding.requiredExternalRuntimePeers !== 'peerDependencies-compatible-range-plus-dev-catalog-exact'
  || dependencyEncoding.optionalExternalRuntimePeers !== 'peerDependencies-compatible-range-plus-meta-optional-plus-dev-catalog-exact') {
  fail('target manifest dependency/peer encoding policy drifted')
}
const capabilityMetadata = topology.manifestPolicy.capabilityMetadata
if (capabilityMetadata.field !== 'aiAgentSdk'
  || capabilityMetadata.runtime !== 'from-package-rule'
  || capabilityMetadata.coreApi !== 1
  || capabilityMetadata.rolesField !== 'roles'
  || capabilityMetadata.nonExecutable !== true) {
  fail('target package capability metadata policy drifted')
}
const expectedManifestRoles = new Map<string, readonly string[]>([
  ['@ai-agent-sdk/core', ['core-runtime']],
  ['@ai-agent-sdk/provider-openai', ['model-provider']],
  ['@ai-agent-sdk/provider-anthropic', ['model-provider']],
  ['@ai-agent-sdk/provider-codex', ['model-provider']],
  ['@ai-agent-sdk/provider-http', ['provider-extension-kit']],
  ['@ai-agent-sdk/protocol-responses', ['wire-protocol']],
  ['@ai-agent-sdk/protocol-anthropic-messages', ['wire-protocol']],
  ['@ai-agent-sdk/mcp', ['mcp-client', 'tool-source']],
  ['@ai-agent-sdk/mcp-server', ['mcp-server']],
  ['@ai-agent-sdk/mcp-node', ['mcp-client-transport']],
  ['@ai-agent-sdk/mcp-node-server', ['mcp-server-transport']],
  ['@ai-agent-sdk/skill-filesystem', ['skill-provider']],
  ['@ai-agent-sdk/observability-fetch', ['observation-exporter']],
  ['@ai-agent-sdk/observability-browser', ['observation-exporter']],
  ['@ai-agent-sdk/observability-node', ['observation-exporter', 'diagnostics']],
  ['@ai-agent-sdk/observability-otel', ['observation-processor']],
  ['@ai-agent-sdk/auth-node', ['credential-source', 'credential-store']],
  ['@ai-agent-sdk/a2a', ['agent-transport']],
])
assertSameSet(
  'package capability metadata roles',
  new Set(capabilityMetadata.allowedRoles),
  new Set([...expectedManifestRoles.values()].flat()),
)
assertSameSet(
  'package capability metadata owners',
  new Set(expectedManifestRoles.keys()),
  new Set(Object.keys(topology.packages)),
)
assertSameSet(
  'automated evidence allowlist',
  new Set(topology.automatedEvidencePolicy.allowed),
  new Set([
    'static-manifest-import-audit',
    'dependency-graph-audit',
    'typescript-compile-only-contract',
    'deterministic-unit-test',
    'executable-spike',
    'live-provider',
    'external-network',
    'credentialed-runtime-acceptance',
  ]),
)
assertSameSet(
  'manual-only evidence classes',
  new Set(topology.automatedEvidencePolicy.manualOnly),
  new Set<string>(),
)
if (topology.automatedEvidencePolicy.broadCommandsAllowedForAi !== true) {
  fail('broad test commands must remain explicitly authorized by the evidence policy')
}
assertSameSet(
  'known automated command hazards',
  new Set(Object.keys(topology.automatedEvidencePolicy.knownBroadCommandHazards)),
  new Set(['check:supply-chain']),
)
assertSameSet(
  'supply-chain command hazard reasons',
  new Set(topology.automatedEvidencePolicy.knownBroadCommandHazards['check:supply-chain'] ?? []),
  new Set(['external-registry-advisory-query-without---skip-audit']),
)
assertSameSet(
  'quarantined historical test inventory',
  new Set(Object.keys(topology.automatedEvidencePolicy.quarantinedHistoricalTests)),
  new Set(),
)
const removedSpikeTest = join(workspace, 'tests/unit/core-capability-runtime-spike.spec.ts')
if (existsSync(removedSpikeTest)) {
  fail('obsolete runtime-spike unit test must not be restored')
}
const rootScripts = (JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>
}).scripts ?? {}
if (!rootScripts.test?.includes('vitest run') || !rootScripts['test:unit']?.includes('tests/unit')) {
  fail('quarantined historical test no longer matches the recorded root test routing')
}
if (rootScripts['check:supply-chain'] !== 'node scripts/check-supply-chain.mts') {
  fail('supply-chain command no longer matches its recorded external-network hazard')
}
const supplyChainChecker = readFileSync(join(workspace, 'scripts/check-supply-chain.mts'), 'utf8')
if (!supplyChainChecker.includes("process.argv.includes('--skip-audit')")
  || !supplyChainChecker.includes("['audit', '--prod', '--json']")) {
  fail('supply-chain checker no longer exposes the recorded local-only skip-audit route')
}
const vitestConfig = readFileSync(join(workspace, 'vitest.config.ts'), 'utf8')
if (!vitestConfig.includes("'tests/integration/**'")
  || vitestConfig.includes('core-capability-runtime-spike.spec.ts')) {
  fail('default Vitest config must exclude integrations without retaining obsolete spike quarantine')
}
assertSameSet(
  'TOCTOU-safe executable capability families',
  new Set(topology.capabilityObjectPolicy.families),
  new Set([
    'model-provider-plugin',
    'credential-source',
    'credential-store',
    'tool-source',
    'skill-provider',
    'memory-store',
    'observation-exporter',
    'http-wire-protocol',
  ]),
)
assertSameSet(
  'capability preflight snapshot fields',
  new Set(topology.capabilityObjectPolicy.captureAtPreflight),
  new Set(['kind', 'apiVersion', 'id', 'configuration-snapshot', 'method-references']),
)
const capabilityPolicy = topology.capabilityObjectPolicy
if (capabilityPolicy.helperReturnsNewWrapper !== true
  || capabilityPolicy.helperResultFrozen !== true
  || capabilityPolicy.runtimeMutatesCallerObject !== false
  || capabilityPolicy.rereadIdentityAfterPreflight !== false
  || capabilityPolicy.rereadMethodsAfterPreflight !== false
  || capabilityPolicy.captureReturnedCleanupImmediately !== true
  || capabilityPolicy.capabilityOwnedStateMayMutate !== true
  || capabilityPolicy.dynamicDataChangesThroughFamilyMethodsOnly !== true
  || capabilityPolicy.hostileProxyIsSecurityBoundary !== false) {
  fail('executable capability snapshot/freeze policy drifted')
}
const providerLifecyclePolicy = topology.providerLifecyclePolicy
if (providerLifecyclePolicy.setup !== 'synchronous-only'
  || providerLifecyclePolicy.cleanup !== 'synchronous-only'
  || providerLifecyclePolicy.asyncResult !== 'reject-and-contain'
  || providerLifecyclePolicy.registrarAfterSetup !== 'sealed'
  || providerLifecyclePolicy.topologyRemovalBeforeCleanup !== true
  || providerLifecyclePolicy.startedCleanupCanBePreemptedByDeadline !== false) {
  fail('provider activation/cleanup lifecycle policy drifted')
}
const coreIdentityPolicy = topology.coreIdentityPolicy
if (coreIdentityPolicy.officialPackedClosure !== 'single-physical-core-resolution'
  || coreIdentityPolicy.runtimeCoreNormalDependency !== 'forbidden'
  || coreIdentityPolicy.crossPackageProtocolValidation !== 'structural-family-marker-and-validated-data'
  || coreIdentityPolicy.crossPackageInstanceofGate !== 'forbidden'
  || coreIdentityPolicy.modelAdapterClassRole !== 'authoring-convenience-not-runtime-nominal-gate'
  || coreIdentityPolicy.foreignFailurePolicy !== 'validated-data-envelope'
  || coreIdentityPolicy.globalDuplicateCoreDetector !== 'forbidden'
  || coreIdentityPolicy.publicReexports !== 'canonical-value-identity') {
  fail('core runtime identity/interoperability policy drifted')
}
for (const [file, constructors] of Object.entries(
  coreIdentityPolicy.currentNominalBoundaryInventory,
)) {
  const absolute = join(workspace, file)
  const source = readFileSync(absolute, 'utf8')
  for (const [constructor, expectedCount] of Object.entries(constructors)) {
    const escaped = constructor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const actualCount = [...source.matchAll(new RegExp(`instanceof\\s+${escaped}\\b`, 'g'))].length
    if (actualCount !== expectedCount) {
      fail(`${file} has ${actualCount} cross-package instanceof ${constructor} check(s); expected ${expectedCount}`)
    }
  }
}
const httpHeaderPolicy = topology.httpHeaderPolicy
if (httpHeaderPolicy.normalization !== 'lowercase-case-insensitive'
  || httpHeaderPolicy.merge !== 'reject-cross-layer-collision'
  || httpHeaderPolicy.endpointStaticSensitiveHeaders !== 'forbidden-use-auth-scheme'
  || httpHeaderPolicy.authenticationHeadersSensitiveByProvenance !== true
  || httpHeaderPolicy.wireLogRedaction !== 'auth-provenance-plus-sensitive-name-policy'
  || httpHeaderPolicy.credentialResolution !== 'once-per-prepared-logical-call'
  || httpHeaderPolicy.retryCredentialBehavior !== 'reuse-prepared-connection-snapshot'
  || httpHeaderPolicy.crossOriginCredentialForwarding !== false
  || httpHeaderPolicy.redirectValidation !== 'before-each-hop') {
  fail('HTTP header ownership/redaction policy drifted')
}
assertSameSet(
  'HTTP header ownership layers',
  new Set(httpHeaderPolicy.layers),
  new Set(['transport', 'sdk-attribution', 'wire-protocol', 'endpoint-static', 'authentication']),
)
assertSameSet(
  'HTTP transport-reserved headers',
  new Set(httpHeaderPolicy.transportReserved),
  new Set(['accept', 'content-type']),
)
assertSameSet(
  'HTTP SDK-reserved header prefixes',
  new Set(httpHeaderPolicy.sdkReservedPrefixes),
  new Set(['x-ai-agent-sdk-']),
)
assertSameSet(
  'HTTP SDK-reserved headers',
  new Set(httpHeaderPolicy.sdkReservedHeaders),
  new Set(['user-agent']),
)
const modelCatalogPolicy = topology.modelCatalogPolicy
if (modelCatalogPolicy.cacheScope !== 'provider-plugin-instance-and-route'
  || modelCatalogPolicy.staticModelsBypassDiscovery !== true
  || modelCatalogPolicy.failureStoredAsSuccessfulEmpty !== false
  || modelCatalogPolicy.lastGoodSnapshotPreservedOnFailure !== true
  || modelCatalogPolicy.concurrentRefresh !== 'singleflight-per-cache-key'
  || modelCatalogPolicy.callerAbort !== 'detach-waiter-without-aborting-other-waiters'
  || modelCatalogPolicy.allWaitersAbort !== 'abort-shared-refresh'
  || modelCatalogPolicy.failureBackoff !== 'bounded-configurable-separate-from-success-ttl'
  || modelCatalogPolicy.defaultFreshTtlMs !== 300_000
  || modelCatalogPolicy.defaultStaleTtlMs !== 0
  || modelCatalogPolicy.defaultFailureBackoffMs !== 5_000
  || modelCatalogPolicy.maxFailureBackoffMs !== 60_000
  || modelCatalogPolicy.explicitModelInvocationRequiresCatalogMembership !== false
  || modelCatalogPolicy.accountSwitchRequiresNewProviderInstance !== true) {
  fail('model catalog cache/state policy drifted')
}
assertSameSet(
  'model catalog states',
  new Set(modelCatalogPolicy.states),
  new Set(['static', 'fresh', 'empty', 'stale', 'unavailable']),
)
assertSameSet(
  'high-level runtime catalog surface',
  new Set(modelCatalogPolicy.highLevelRuntimeSurface),
  new Set(['providers', 'modelCatalog']),
)
const providerDiscoveryIdentityPolicy = topology.providerDiscoveryIdentityPolicy
if (providerDiscoveryIdentityPolicy.rowScope !== 'one-row-per-route'
  || providerDiscoveryIdentityPolicy.modelTargetKey !== 'route'
  || providerDiscoveryIdentityPolicy.instanceKey !== 'pluginId'
  || providerDiscoveryIdentityPolicy.familyKey !== 'family'
  || providerDiscoveryIdentityPolicy.officialFamily !== 'fixed-by-provider-package'
  || providerDiscoveryIdentityPolicy.customFamilyFallback !== 'plugin-id'
  || providerDiscoveryIdentityPolicy.legacyAliases.id !== 'route'
  || providerDiscoveryIdentityPolicy.legacyAliases.name !== 'adapter-display-name'
  || providerDiscoveryIdentityPolicy.multiRoutePlugin !== 'rows-share-plugin-id-and-family'
  || providerDiscoveryIdentityPolicy.catalogLookupKey !== 'route'
  || providerDiscoveryIdentityPolicy.credentialDerivedIdentityForbidden !== true) {
  fail('provider discovery identity policy drifted')
}
const officialProviderFactoryPolicy = topology.officialProviderFactoryPolicy
if (officialProviderFactoryPolicy.normalInstall !== 'core-plus-one-official-provider'
  || officialProviderFactoryPolicy.supportPackages !== 'transitive-hidden-from-normal-consumer-imports'
  || officialProviderFactoryPolicy.factory !== 'synchronous-side-effect-free-no-credential-resolution-or-io'
  || officialProviderFactoryPolicy.defaultInstanceId !== 'provider-family'
  || officialProviderFactoryPolicy.defaultRoutes !== 'single-instance-id-route'
  || officialProviderFactoryPolicy.explicitRoutes !== 'nonempty-unique-alias-claims'
  || officialProviderFactoryPolicy.customInstanceErgonomics !== 'id-alone-selects-default-route'
  || officialProviderFactoryPolicy.pluginOptions !== 'adapter-options-plus-id-routes-and-injected-fetch'
  || officialProviderFactoryPolicy.providerSpecificOptions !== 'preserved-through-recommended-plugin-factory'
  || officialProviderFactoryPolicy.credentialOwnership !== 'required-injected-web-safe-capability-no-env-read'
  || officialProviderFactoryPolicy.advancedAdapter !== 'retained-but-not-required-for-normal-composition'
  || officialProviderFactoryPolicy.family !== 'fixed-by-official-package-not-user-configurable'
  || officialProviderFactoryPolicy.instanceScopedPromptCacheKey !== 'never-described-as-conversation-boundary') {
  fail('official provider factory ergonomics policy drifted')
}
const additiveCapabilityCompositionPolicy = topology.additiveCapabilityCompositionPolicy
if (additiveCapabilityCompositionPolicy.normalShape !== 'named-factory-or-explicit-connect-then-typed-slot'
  || additiveCapabilityCompositionPolicy.skillFilesystem !== 'preserved-advanced-plus-versioned-lazy-borrowed-plugin-node'
  || additiveCapabilityCompositionPolicy.mcpConnection !== 'async-connected-borrowed-tool-source-caller-close'
  || additiveCapabilityCompositionPolicy.observationExporter !== 'inert-exporter-explicit-owned-or-borrowed-registration'
  || additiveCapabilityCompositionPolicy.openTelemetry !== 'caller-owned-bridge-open-span-plus-processor-not-exporter'
  || additiveCapabilityCompositionPolicy.openTelemetryProviderShutdown !== 'caller-owned-never-runtime'
  || additiveCapabilityCompositionPolicy.factoryOptions !== 'preserve-operational-bounds-and-injected-host-functions'
  || additiveCapabilityCompositionPolicy.runtimeElevation !== 'selected-capability-package-not-core'
  || additiveCapabilityCompositionPolicy.implicitEnvironmentOrFilesystem !== false
  || additiveCapabilityCompositionPolicy.catchAllPluginArray !== false) {
  fail('additive capability composition policy drifted')
}
const capabilityOperationLoggingPolicy = topology.capabilityOperationLoggingPolicy
if (capabilityOperationLoggingPolicy.coreLifecycleEvidence !== 'start-terminal-error-independent-of-plugin-logging'
  || capabilityOperationLoggingPolicy.exporterLoggerInjection !== 'forbidden-recursion-boundary'
  || capabilityOperationLoggingPolicy.correlationAuthority !== 'runtime-generated-not-plugin-overridable'
  || capabilityOperationLoggingPolicy.sensitiveFields !== 'credentials-content-and-raw-errors-forbidden'
  || capabilityOperationLoggingPolicy.accountingAuthority !== 'terminal-ledger-never-plugin-log'
  || capabilityOperationLoggingPolicy.loggerFailure !== 'contained-observation-health-never-primary-operation-error') {
  fail('capability operation logging policy drifted')
}
assertSameSet(
  'required versioned capability logger contexts',
  new Set(capabilityOperationLoggingPolicy.requiredBoundLoggerContexts),
  new Set([
    'provider-setup-registrar',
    'credential-operation',
    'tool-source-snapshot',
    'skill-provider-operation',
    'memory-store-operation',
  ]),
)
assertSameSet(
  'legacy optional logger contexts',
  new Set(capabilityOperationLoggingPolicy.legacyOptionalLoggerContexts),
  new Set(['model-invocation', 'tool-run', 'turn-hook']),
)
}
// @ts-nocheck
