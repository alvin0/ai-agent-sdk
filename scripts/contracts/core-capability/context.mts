import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ApiMigration,
  DocumentationMigrationBaseline,
  InstallClosureBaseline,
  ManifestBlueprints,
  Phase0Decisions,
  ProviderApiBaseline,
  RetainedPackageApiBaseline,
  SourceMigrationBaseline,
} from './types.mts'
import type { Topology } from './topology.mts'

export interface ContractMetrics {
  declarationEdges: number
  validatedMigratedManifestCount: number
  apiBaselineSymbolCount: number
  apiProposedRemovalCount: number
  targetApiMissingSymbolCount: number
  providerApiBaselineSymbolCount: number
  retainedPackageApiBaselineSymbolCount: number
  retainedPackageTargetMissingSymbolCount: number
  retainedPackageMovedSymbolCount: number
  externalRuntimeDependencies: Set<string>
}

export interface ContractContext {
  readonly workspace: string
  readonly contractRoot: string
  readonly configPath: string
  readonly topology: Topology
  readonly phase0: Phase0Decisions
  readonly apiMigration: ApiMigration
  readonly providerApiBaseline: ProviderApiBaseline
  readonly retainedPackageApiBaseline: RetainedPackageApiBaseline
  readonly manifestBlueprints: ManifestBlueprints
  readonly installClosures: InstallClosureBaseline
  readonly sourceMigration: SourceMigrationBaseline
  readonly documentationMigration: DocumentationMigrationBaseline
  readonly capabilityMetadata: Topology['manifestPolicy']['capabilityMetadata']
  readonly expectedManifestRoles: ReadonlyMap<string, readonly string[]>
  readonly packageBySpecifier: Map<string, string>
  readonly declarationDependencies: Map<string, Set<string>>
  readonly metrics: ContractMetrics
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

export function loadContractContext(): ContractContext {
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..', '..')
  const contractRoot = join(workspace, 'design-contracts/core-capability-v1')
  const topology = JSON.parse(
    readFileSync(join(contractRoot, 'topology.json'), 'utf8'),
  ) as Topology
  const phase0 = JSON.parse(
    readFileSync(join(contractRoot, 'phase0-decisions.json'), 'utf8'),
  ) as Phase0Decisions
  const apiMigration = JSON.parse(
    readFileSync(join(contractRoot, 'api-migration.json'), 'utf8'),
  ) as ApiMigration
  const providerApiBaseline = JSON.parse(
    readFileSync(join(contractRoot, 'provider-api-baseline.json'), 'utf8'),
  ) as ProviderApiBaseline
  const retainedPackageApiBaseline = JSON.parse(
    readFileSync(join(contractRoot, 'retained-package-api-baseline.json'), 'utf8'),
  ) as RetainedPackageApiBaseline
  const manifestBlueprints = JSON.parse(
    readFileSync(join(contractRoot, topology.manifestPolicy.blueprint), 'utf8'),
  ) as ManifestBlueprints
  const installClosures = JSON.parse(
    readFileSync(join(contractRoot, 'install-closures.json'), 'utf8'),
  ) as InstallClosureBaseline
  const sourceMigration = JSON.parse(
    readFileSync(join(contractRoot, 'source-migration.json'), 'utf8'),
  ) as SourceMigrationBaseline
  const documentationMigration = JSON.parse(
    readFileSync(join(contractRoot, 'documentation-migration.json'), 'utf8'),
  ) as DocumentationMigrationBaseline
  return {
    workspace,
    contractRoot,
    configPath: join(contractRoot, 'tsconfig.json'),
    topology,
    phase0,
    apiMigration,
    providerApiBaseline,
    retainedPackageApiBaseline,
    manifestBlueprints,
    installClosures,
    sourceMigration,
    documentationMigration,
    capabilityMetadata: topology.manifestPolicy.capabilityMetadata,
    expectedManifestRoles,
    packageBySpecifier: new Map(),
    declarationDependencies: new Map(),
    metrics: {
      declarationEdges: 0,
      validatedMigratedManifestCount: 0,
      apiBaselineSymbolCount: 0,
      apiProposedRemovalCount: 0,
      targetApiMissingSymbolCount: 0,
      providerApiBaselineSymbolCount: 0,
      retainedPackageApiBaselineSymbolCount: 0,
      retainedPackageTargetMissingSymbolCount: 0,
      retainedPackageMovedSymbolCount: 0,
      externalRuntimeDependencies: new Set(),
    },
  }
}
