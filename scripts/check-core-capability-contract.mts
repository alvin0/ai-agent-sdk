import { loadContractContext } from './contracts/core-capability/context.mts'
import { validateManifestAndEvidencePolicies } from './contracts/core-capability/manifest-policies.mts'
import { validateIntegrationPolicies } from './contracts/core-capability/integration-policies.mts'
import { validateCompatibilityPolicies } from './contracts/core-capability/compat-policies.mts'
import { validateCompileContracts } from './contracts/core-capability/compile-contracts.mts'
import { prepareContractIndex, validateAuthRoutes } from './contracts/core-capability/contract-index.mts'
import { validateDeclarationGraph } from './contracts/core-capability/declaration-graph.mts'
import { validateJourneyAndRemovals } from './contracts/core-capability/journey-checks.mts'
import { validateManifestBlueprintContract } from './contracts/core-capability/manifest-validation.mts'
import { validateRecommendedCompositionEntrypoints } from './contracts/core-capability/composition-entrypoints.mts'
import { validatePhase0Decisions } from './contracts/core-capability/phase0.mts'
import { validateSourceMigrationBaseline } from './contracts/core-capability/source-migration.mts'
import { validateDocumentationMigrationBaseline } from './contracts/core-capability/documentation-migration.mts'
import { validateApiMigration } from './contracts/core-capability/api-migration.mts'
import { validateProviderApiBaseline } from './contracts/core-capability/provider-api.mts'
import { validateRetainedPackageApiBaseline } from './contracts/core-capability/retained-api.mts'
import { validateRuntimeBaselines } from './contracts/core-capability/runtime-baselines.mts'
import { validateCompositionContractPart1 } from './contracts/core-capability/composition-contract-part1.mts'
import { validateCompositionContractPart2 } from './contracts/core-capability/composition-contract-part2.mts'
import { validateImplementationLedger } from './contracts/core-capability/implementation-ledger.mts'
import { validateDocumentedInstallRecipes } from './contracts/core-capability/install-recipes.mts'
import { validateMigratedManifests } from './contracts/manifest-policy.mts'

const context = loadContractContext()
validateManifestAndEvidencePolicies(context)
validateIntegrationPolicies(context)
validateCompatibilityPolicies(context)
validateCompileContracts(context)

prepareContractIndex(context)
validateManifestBlueprintContract(context)
context.metrics.validatedMigratedManifestCount = validateMigratedManifests(
  context.workspace,
  context.topology,
  context.manifestBlueprints,
)
validateRecommendedCompositionEntrypoints(context)
validateAuthRoutes(context)
validateDeclarationGraph(context)

validatePhase0Decisions(context)
validateSourceMigrationBaseline(context)
validateDocumentationMigrationBaseline(context)
validateApiMigration(context)
validateProviderApiBaseline(context)
validateRetainedPackageApiBaseline(context)
validateRuntimeBaselines(context)
validateCompositionContractPart1(context)
validateCompositionContractPart2(context)
validateImplementationLedger(context)
validateDocumentedInstallRecipes(context)
validateJourneyAndRemovals(context)

const { topology, phase0, apiMigration, sourceMigration, documentationMigration, manifestBlueprints } = context
const { capabilityMetadata, packageBySpecifier, metrics } = context
console.log(
  `Core capability contract passed: ${Object.keys(topology.packages).length} package(s), `
  + `${packageBySpecifier.size} import specifier(s), ${metrics.declarationEdges} declaration edge(s), `
  + `${topology.journeys.length} journey topology check(s), `
  + `3 runtime baseline(s), `
  + `${topology.capabilityObjectPolicy.families.length} executable capability snapshot rule(s), `
  + `1 HTTP wire body policy, `
  + `1 SSE transport policy, `
  + `1 Edge website deployment policy, `
  + `1 run-scoped instruction policy, `
  + `1 run-handle cancellation policy, `
  + `1 invocation observer policy, `
  + `1 curated core root facade, `
  + `${Object.keys(manifestBlueprints.packages).length} exact manifest export blueprint(s), `
  + `${metrics.validatedMigratedManifestCount} migrated manifest(s), `
  + `1 retained binary entrypoint, `
  + `${Object.values(sourceMigration.roots).reduce((total, root) => total + root.fileCount, 0)} source-migration file(s), `
  + `${Object.keys(documentationMigration.removedPackages).length} documentation migration route inventory(s), `
  + `${Object.values(documentationMigration.fileDispositions).flat().length} classified documentation file(s), `
  + `${Object.keys(context.installClosures.journeys).length} frozen install closure(s), `
  + `${Object.keys(context.installClosures.packageProbes).length} package-local closure probe(s), `
  + `13 documented install recipe(s), `
  + `${Object.keys(topology.recommendedCompositionEntrypoints).length} recommended composition entrypoint(s), `
  + `${Object.keys(topology.recommendedCompositionEntrypoints).length} typed composition proof(s), `
  + `${topology.capabilityOperationLoggingPolicy.requiredBoundLoggerContexts.length} required capability logger context(s), `
  + `${topology.callerOwnedIntegrationLoggingPolicy.coveredIntegrations.length} caller-owned integration logger family/families, `
  + `${Object.values(topology.callerOwnedIntegrationLoggingPolicy.operationEvidence).flat().length} integration operation evidence row(s), `
  + `${Object.keys(topology.callerOwnedIntegrationLoggingPolicy.postRuntimeTeardownEvidence).length} post-runtime teardown report route(s), `
  + `${capabilityMetadata.allowedRoles.length} package metadata role(s), `
  + `1 observability compatibility policy, `
  + `1 observability capability dual-compile compatibility policy, `
  + `1 MCP split-route dual-compile compatibility policy, `
  + `1 Auth/Codex dual-compile compatibility policy, `
  + `1 A2A dual-compile compatibility policy, `
  + `1 filesystem-skill dual-compile compatibility policy, `
  + `1 skill-validation subpath dual-compile compatibility policy, `
  + `1 official-provider signature dual-compile compatibility policy, `
  + `1 core message dual-compile compatibility policy, `
  + `1 core provider dual-compile compatibility policy, `
  + `${Object.keys(topology.protocolCompatibilityPolicy.packages).length} wire protocol dual-compile compatibility policies, `
  + `1 agent tool dual-compile compatibility policy, `
  + `1 agent skill dual-compile compatibility policy, `
  + `1 agent memory/history dual-compile compatibility policy, `
  + `1 agent accounting/trace dual-compile compatibility policy, `
  + `1 agent loop/definition dual-compile compatibility policy, `
  + `1 agent team dual-compile compatibility policy, `
  + `1 official provider factory policy, `
  + `1 additive capability composition policy, `
  + `${topology.runtimeOperationPolicy.trackedKinds.length} runtime operation lease kind(s), `
  + `2 borrowed-resource lifecycle check(s), `
  + `${Object.keys(topology.removalMigrationInventory).length} removed-package migration inventory check(s), `
  + `${metrics.externalRuntimeDependencies.size} exact external runtime dependency/peer declaration(s), `
  + `${phase0.decisions.length} Phase 0 decision record(s), 9 implementation slice(s), `
  + `${metrics.apiBaselineSymbolCount} API baseline symbol(s), `
  + `${metrics.targetApiMissingSymbolCount} pending target API parity symbol(s), `
  + `${metrics.providerApiBaselineSymbolCount} retained provider API baseline symbol(s), `
  + `${metrics.retainedPackageApiBaselineSymbolCount} retained non-core/provider entrypoint API symbol(s), `
  + `${metrics.retainedPackageTargetMissingSymbolCount} pending retained-package target parity symbol(s), `
  + `${metrics.retainedPackageMovedSymbolCount} explicitly routed moved export(s), `
  + `${metrics.apiProposedRemovalCount} proposed removal(s), `
  + `${apiMigration.canonicalCollisions.length} canonical collision(s).`,
)
