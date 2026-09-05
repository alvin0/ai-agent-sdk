// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateCompositionContractPart1(ctx: ContractContext): void {
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
  const coreDeclaration = readFileSync(join(contractRoot, 'packages/core/index.d.ts'), 'utf8')
  assertSameSet(
    'core public subpaths',
    new Set(topology.packages['@ai-agent-sdk/core']?.specifiers ?? []),
    new Set([
      '@ai-agent-sdk/core',
      '@ai-agent-sdk/core/agent',
      '@ai-agent-sdk/core/memory',
      '@ai-agent-sdk/core/observability',
      '@ai-agent-sdk/core/provider',
      '@ai-agent-sdk/core/skills',
      '@ai-agent-sdk/core/tools',
    ]),
  )
  if (!topology.journeys.some(journey => journey.id === 'core-subpath-author')) {
    fail('target journeys do not prove the bounded core author subpaths')
  }
  for (const field of [
    'export interface CorrelationContext',
    'readonly conversationId?: string',
    'readonly sessionId?: string',
    'readonly correlation?: Partial<CorrelationContext>',
    'export interface ObservationProcessor',
    'export interface OpenObservationSpanInput',
    'readonly processors?: readonly ObservationProcessor[]',
    'readonly redactors?: readonly ContentRedactor[]',
    'readonly openSpan?: (input: OpenObservationSpanInput) => ObservationSpan',
  ]) {
    if (!coreDeclaration.includes(field)) {
      fail(`model invocation correlation contract does not expose '${field}'`)
    }
  }
  if (!/interface RuntimeObservationExporterRegistration[\s\S]*?readonly ownership: 'borrowed' \| 'owned'/.test(coreDeclaration)) {
    fail('observation exporter registration must require explicit borrowed/owned ownership')
  }
  for (const field of [
    "readonly kind: 'model-provider-plugin'",
    'export interface ComposableModelProviderPlugin extends ModelProviderPlugin',
    'readonly routes: readonly string[]',
    'export interface ComposableModelProviderRegistrar',
    'adapter: ModelAdapter,',
    'routes?: readonly string[]',
    'readonly providers: readonly ComposableModelProviderPlugin[]',
    "readonly kind: 'observation-exporter'",
    'export type ProviderPluginCleanupDefinition = () => undefined',
    "'kind' | 'apiVersion' | 'setup'",
    ') => undefined | ProviderPluginCleanupDefinition',
    "readonly SETUP_ASYNC_UNSUPPORTED: 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'",
    "readonly CLEANUP_ASYNC_UNSUPPORTED: 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED'",
    'readonly ready?: (signal: AbortSignal) => Promise<void>',
    'readonly signal?: AbortSignal',
    'readonly startupTimeoutMs?: number',
    'export declare class AgentRuntimeConstructionError extends Error',
    "readonly code: 'RUNTIME_CONSTRUCTION_FAILED'",
    "readonly stage: 'preflight' | 'provider-setup' | 'exporter-ready' | 'activation'",
    'readonly reason: RuntimeConstructionFailureReason',
    'readonly component?: RuntimeConstructionComponent',
    'readonly failureCode: RuntimeConstructionFailureCode',
    'readonly conflict?: CapabilityIdentityConflict',
    'readonly cleanup: readonly RuntimeComponentCloseReport[]',
    "export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'",
    'export interface SdkLogger',
    'child(fields: Readonly<JsonObject>): SdkLogger',
    'readonly logger?: SdkLogger',
    'logger(context?: RuntimeLoggerContext): SdkLogger',
    'readonly minimumLogLevel?: LogLevel',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core startup/rollback contract does not expose '${field}'`)
  }
  for (const field of [
    'readonly setup: (registrar: ModelProviderRegistrar) => void | (() => void)',
    'readonly resolve: (options: CredentialOperationOptions) => string | Promise<string>',
    'readonly read: (options: CredentialOperationOptions) => Promise<CredentialRecord<Value> | undefined>',
    'readonly get: (name: string) => ToolDefinition | undefined',
    'readonly list: (options: RuntimeSkillLookupOptions & {',
    'readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>',
    'export interface ObservationExporterPlugin',
    'batch: ObservationDeliveryBatch,',
    ') => Promise<ObservationDeliveryAck>',
    'readonly shutdown?: (signal: AbortSignal) => Promise<void>',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`capability method table is not readonly: '${field}'`)
  }
  for (const field of [
    "| 'CAPABILITY_ID_CONFLICT'",
    "| 'PROVIDER_ROUTE_CONFLICT'",
    "| 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'",
    "| 'provider-plugin-id'",
    "| 'provider-route'",
    "| 'observation-exporter-id'",
    "| 'tool-source-id'",
    "| 'tool-name'",
    "| 'skill-provider-id'",
    "| 'skill-id'",
    "| 'team-member-name'",
    'readonly firstIndex: number',
    'readonly secondIndex: number',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core identity-conflict contract does not expose '${field}'`)
  }
  const runtimeLoggerContext = coreDeclaration.match(
    /export interface RuntimeLoggerContext\s*{(?<body>[\s\S]*?)\n}/,
  )?.groups?.body ?? ''
  for (const forbidden of ['resource', 'runtimeId', 'traceId', 'spanId', 'correlation']) {
    if (runtimeLoggerContext.includes(forbidden)) {
      fail(`runtime logger context must not allow caller override '${forbidden}'`)
    }
  }
  for (const contextName of ['ToolRunContext', 'TurnHookContext']) {
    const contextBody = coreDeclaration.match(
      new RegExp(`export interface ${contextName}(?:\\s+extends\\s+[^\\n{]+)?\\s*{(?<body>[\\s\\S]*?)\\n}`),
    )?.groups?.body ?? ''
    if (!contextBody.includes('readonly logger?: SdkLogger')
      || contextBody.includes('readonly logger: SdkLogger')) {
      fail(`${contextName} logging must remain additive-compatible and optional in the public type`)
    }
  }
  for (const contextName of [
    'ComposableModelProviderRegistrar',
    'CredentialOperationOptions',
    'ToolSourceSnapshotOptions',
    'MemoryStoreOptions',
  ]) {
    const contextBody = coreDeclaration.match(
      new RegExp(`export interface ${contextName}(?:\\s+extends\\s+[^\\n{]+)?\\s*{(?<body>[\\s\\S]*?)\\n}`),
    )?.groups?.body ?? ''
    if (!contextBody.includes('readonly logger: SdkLogger')
      || contextBody.includes('readonly logger?: SdkLogger')) {
      fail(`${contextName} must receive one required runtime-bound logger`)
    }
  }
  const runtimeSkillContext = coreDeclaration.match(
    /export type RuntimeSkillLookupOptions[\s\S]*?&\s*{(?<body>[\s\S]*?)\n}/,
  )?.groups?.body ?? ''
  if (!runtimeSkillContext.includes('readonly logger: SdkLogger')
    || runtimeSkillContext.includes('readonly logger?: SdkLogger')) {
    fail('RuntimeSkillLookupOptions must receive one required runtime-bound logger')
  }
  const exporterPluginBody = coreDeclaration.match(
    /export interface ObservationExporterPlugin\s*{(?<body>[\s\S]*?)\n}/,
  )?.groups?.body ?? ''
  if (/\blogger\??:/.test(exporterPluginBody)) {
    fail('observation exporter plugin must not receive a recursive logger')
  }
  const capabilityAuthorLogging = readFileSync(
    join(contractRoot, 'consumers/capability-author.ts'),
    'utf8',
  )
  for (const proof of [
    "options.logger.debug('resolve example credential')",
    "options.logger.debug('read credential metadata')",
    "options.logger.debug('commit credential revision')",
    "options.logger.debug('load memory revision')",
    "options.logger.debug('commit memory revision')",
    "options.logger.debug('list skill metadata')",
    "options.logger.debug('load skill instructions')",
    "options.logger.debug('read skill resource')",
    "options.logger.debug('snapshot tool source')",
    'satisfies readonly IntegrationOperationEvidenceFields[]',
    "kind: 'logical-start'",
    "kind: 'attempt-start'",
    "kind: 'attempt-terminal'",
    "kind: 'logical-terminal'",
    "logger.info('integration operation evidence', event)",
    'health: RuntimeObservationHealthSnapshot',
    'const { accepted, filtered, dropped, rejected } = health.integrationEvidence',
    'return filtered > 0 || dropped > 0 || rejected > 0',
  ]) {
    if (!capabilityAuthorLogging.includes(proof)) {
      fail(`versioned capability logging proof lacks '${proof}'`)
    }
  }
  const providerAuthorLogging = readFileSync(
    join(contractRoot, 'consumers/provider-author.ts'),
    'utf8',
  )
  if (!providerAuthorLogging.includes("registrar.logger.debug('register example provider')")) {
    fail('provider setup registrar does not prove runtime-bound plugin logging')
  }
  for (const brokerName of ['ApprovalBroker', 'UserInputBroker']) {
    const brokerBody = coreDeclaration.match(
      new RegExp(`export interface ${brokerName}\\s*{(?<body>[\\s\\S]*?)\\n}`),
    )?.groups?.body ?? ''
    const cancellationSignature = 'signal?: AbortSignal'
    if (!brokerBody.includes('readonly request: (') || !brokerBody.includes(cancellationSignature)) {
      fail(`${brokerName} request method must be readonly and cancellation-aware`)
    }
  }
  if (!/export type ObservationExporterPluginDefinition = Omit<[\s\S]*?'kind' \| 'apiVersion'[\s\S]*?>/.test(coreDeclaration)) {
    fail('observation exporter helper input must omit both runtime marker fields')
  }
  for (const field of [
    'export interface ObservationResourceInput',
    'export interface ObservationResource',
    'readonly runtimeId?: string',
    "readonly sdkName: 'ai-agent-sdk'",
    'readonly sdkVersion: string',
    'readonly resource: ObservationResource',
    'readonly attributes?: Readonly<Record<string, JsonValue>>',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core observation resource contract does not expose '${field}'`)
  }
  if ((coreDeclaration.match(/readonly kind: 'skill'/g) ?? []).length !== 1) {
    fail('SkillDefinition must declare its kind discriminator exactly once')
  }
  for (const field of [
    "readonly CATALOG_INVALID: 'SKILL_CATALOG_INVALID'",
    "readonly REFERENCE_INVALID: 'SKILL_REFERENCE_INVALID'",
    "readonly REFERENCE_UNAVAILABLE: 'SKILL_REFERENCE_UNAVAILABLE'",
    'readonly locator?: JsonValue',
    'export interface SkillCatalogSnapshot',
    'readonly revision: string',
    'readonly candidates: readonly RuntimeSkillCandidate[]',
    'export interface SkillReference',
    'readonly catalogRevision: string',
    '}) => Promise<SkillCatalogSnapshot>',
    'reference: SkillReference,',
    'export interface ActivatedSkillSnapshot extends SkillReference',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core skill reference contract does not expose '${field}'`)
  }
  for (const field of [
    'export interface ToolCatalogSnapshot',
    'readonly tools: readonly ToolDefinition[]',
    'export interface ToolSourceSnapshotOptions',
    'readonly snapshot: (options: ToolSourceSnapshotOptions) => ToolCatalogSnapshot',
    'readonly toolSourceSnapshots: readonly ToolSourceRunReference[]',
    'export interface ToolSourceRunReference',
    'readonly sourceId: string',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core tool-source snapshot contract does not expose '${field}'`)
  }
  for (const field of [
    'MEMORY_STORE_API_VERSION',
    "readonly BINDING_REQUIRED: 'MEMORY_BINDING_REQUIRED'",
    "readonly BINDING_MISMATCH: 'MEMORY_BINDING_MISMATCH'",
    "readonly INVALID_SCOPE: 'MEMORY_INVALID_SCOPE'",
    "readonly kind: 'memory-store'",
    'readonly signal: AbortSignal',
    'readonly expectedRevision: string | null',
    "readonly requirement: 'required' | 'best-effort'",
    'export type MemoryScope =',
    "readonly kind: 'conversation'",
    "readonly kind: 'fixed'",
    'readonly sharedAcrossSessions: true',
    'readonly bindingId: string',
    'readonly scope: MemoryScope',
    'readonly memory?: MemoryBinding',
    'readonly memory?: MemoryBinding | false',
    'readonly memoryBindingId?: string',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core memory contract does not expose '${field}'`)
  }
  for (const field of [
    'CREDENTIAL_CAPABILITY_API_VERSION',
    "readonly kind: 'credential-source'",
    "readonly kind: 'credential-store'",
    'export type CredentialInput = string | CredentialSource',
    'readonly expectedRevision: string | null',
    'defineCredentialSource',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core credential contract does not expose '${field}'`)
  }
  for (const field of [
    "readonly CLOSING: 'RUNTIME_CLOSING'",
    "readonly CLOSED: 'RUNTIME_CLOSED'",
    "readonly OPERATION_TIMEOUT: 'RUNTIME_OPERATION_TIMEOUT'",
    'readonly components: readonly RuntimeComponentCloseReport[]',
    'readonly operations: readonly RuntimeOperationCloseSummary[]',
    "readonly quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'",
    'readonly observationHealth: RuntimeObservationHealthSnapshot',
    'export type RuntimeOperationKind =',
    "| 'model-catalog'",
    "| 'manual-compaction'",
    "| 'team-operation'",
    'export interface RuntimeOperationCloseSummary',
    'readonly activeAtClose: number',
    'readonly unsettled: number',
    "readonly kind: 'provider-registration' | 'observation-exporter' | 'agent-team'",
    "readonly status: 'closed' | 'failed' | 'timed-out'",
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core close contract does not expose '${field}'`)
  }
  for (const field of [
    'defineAgent(input: AgentDefinitionInput)',
    'cloneAgent(',
    'defineTool<Args>',
    'readonly parse?: (raw: unknown) => Args',
    'readonly execute: (',
    'context: ToolRunContext,',
    'readonly render?: (',
    'value: JsonValue | undefined,',
    'readonly meta?: (',
    'readonly isConcurrencySafe?: (input: Args) => boolean',
    'readonly timeoutMs?: number',
    'concludeTurn(): void',
    'addContext(content: string | readonly ContentBlock[]): void',
    'defineSkill(input: SkillDefinitionInput)',
    'defineSkillProvider(provider: SkillProvider): SkillProvider',
    'defineSkillProviderPlugin(',
    'readonly whenToUse?: string',
    'readonly invocation?: Partial<SkillInvocationPolicy>',
    'export interface NativeToolSchemaMap',
    "readonly 'web-search': NativeWebSearchTool",
    "readonly 'image-generation': NativeImageGenerationTool",
    'export type NativeToolName = keyof NativeToolSchemaMap',
    'export type NativeToolSchema = NativeToolSchemaMap[NativeToolName]',
    'export type ModelToolSchema = ToolSchema | NativeToolSchema',
    'readonly nativeTools?: readonly NativeToolSchema[]',
    'readonly toolChoice?: ToolChoice',
    "{ readonly type: 'native'; readonly name: NativeToolName }",
    'tool: ModelToolSchema,',
    'readonly compaction?: AgentCompactionOptions | false',
    'snapshot(): AgentSessionSnapshot',
    'export interface RuntimeAgentInvocationOptions extends AgentRunOptions',
    'readonly onEvent?: (event: RuntimeAgentRunEvent) => void | Promise<void>',
    'compact(invocation?: AgentInvocationOptions): Promise<CompactionResult | null>',
    'compact(options?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null>',
    'resumeSession(',
    "readonly mode?: 'basic' | 'deep' | 'deep-human-in-loop'",
    'export interface ApprovalBroker',
    'export interface UserInputBroker',
    'readonly before?: (',
    'readonly around?: (',
    'readonly after?: (',
    'readonly estimate: (input: UsageEstimationInput)',
    'context: BeforeStepContext,',
    'context: RequestErrorContext,',
    'context: CheckpointContext',
    'context: TurnEndContext',
    'readonly onRequestError?: (',
    'readonly checkpoint?: (',
    'readonly onTurnEnd?: (',
    'createApprovalBroker',
    'createUserInputBroker',
    'readonly interceptors?: readonly ToolInterceptor[]',
    'readonly hooks?: TurnHooks',
    "readonly type: 'approval-request'",
    "readonly type: 'user-input-request'",
    "readonly type: 'user-input-response'",
    'readonly history: HistorySnapshot',
    'readonly entries: readonly HistoryEntry[]',
    'export declare class AgentMemory',
    'export declare class History',
    'export declare class ContextCompactor',
    'export declare const COMPACTION_INSTRUCTION: string',
    'readonly skills?:',
    'team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam',
    "readonly kind: 'provider-registration' | 'observation-exporter' | 'agent-team'",
    'readonly members: readonly AgentTeamMemberInput[]',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core author/session ergonomics contract does not expose '${field}'`)
  }
  for (const field of [
    'export interface AgentDefinitionInput',
    'export interface RuntimeAgentDefinitionInput',
    'defineAgent(input: AgentDefinitionInput): DefinedAgent',
    'defineAgent(input: RuntimeAgentDefinitionInput): RuntimeAgentDefinition',
    'export type AgentRunEvent = AgentEvent',
    'export type RuntimeAgentRunEvent = RuntimeAgentRunEventContext',
    'export declare class AgentSession',
    'export interface RuntimeAgentSession',
    'export declare class AgentTeam',
    'export interface RuntimeAgentTeamOptions',
  ]) {
    if (!coreDeclaration.includes(field)) {
      fail(`legacy/runtime protocol split does not expose '${field}'`)
    }
  }
  const agentRuntimeBody = coreDeclaration.match(
    /export interface AgentRuntime\s*{(?<body>[\s\S]*?)\n}/,
  )?.groups?.body ?? ''
  if (!agentRuntimeBody.includes('agent(definition: RuntimeAgentDefinitionInput): RuntimeAgent')
    || !agentRuntimeBody.includes('team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam')
    || agentRuntimeBody.includes('agent(definition: AgentDefinition)')
    || agentRuntimeBody.includes('team(options: AgentTeamOptions)')) {
    fail('composition runtime must use distinct Runtime agent/team protocols without repurposing legacy names')
  }
  if (coreDeclaration.includes('readonly [option: string]: unknown')) {
    fail('provider-native tool configuration must not expose an arbitrary unknown index signature')
  }
  for (const field of [
    'readonly cacheReadTokens?: number',
    'readonly cacheWriteTokens?: number',
    'readonly reasoningTokens?: number',
    "export type DispatchState = 'not-sent' | 'sent' | 'unknown'",
    'readonly attempts: readonly AttemptUsageReport[]',
    'readonly possiblyBilledAttemptsWithoutUsage: number',
    'readonly authoritative: boolean',
    'readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>',
    'readonly delivery: ObservationDeliverySummary',
    'readonly report: RunReport',
    'export interface RunReport extends RunTerminalRecord',
    'readonly runRecords: readonly RunTerminalRecord[]',
    'readonly acceptedRunIds: readonly string[]',
    'readonly stage?: (item: ObservationExportItem) => void | Promise<void>',
    "export type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'",
    'readonly supportedBoundaries: readonly ObservationBoundary[]',
    'readonly boundary: ObservationBoundary',
    "readonly kind: 'run-terminal-record'",
    'readonly runId: string',
    'readonly traceId: string',
    'readonly spanId: string',
    'readonly sequence: number',
    'readonly priority:',
    "readonly onMissing?: 'warn' | 'estimate' | 'fail'",
    'readonly estimator?: UsageEstimator',
    'readonly request: GenerateOptions',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core accounting contract does not expose '${field}'`)
  }
  if (coreDeclaration.includes('export interface Usage {')) {
    fail('core accounting contract must not collapse canonical reports into a simplified Usage shape')
  }
  if (coreDeclaration.includes("readonly onMissing: 'fail' | 'report'")) {
    fail('core usage policy must preserve warn/estimate/fail behavior during the package migration')
  }
  if (/export interface ObservationDeliveryBatch\s*{[^}]*readonly usage:/s.test(coreDeclaration)) {
    fail('observation batches must carry per-run records instead of one ambiguous batch-level usage value')
  }
  if (/export interface ObservationDeliveryBatch\s*{[^}]*readonly runReports:/s.test(coreDeclaration)) {
    fail('observation batches must not create a delivery cycle by exporting caller-facing RunReport values')
  }
  const skillOptions = coreDeclaration.match(/export interface SkillLookupOptions\s*{(?<body>[\s\S]*?)\n}/)?.groups?.body ?? ''
  const runtimeSkillOptions = coreDeclaration.match(/export type RuntimeSkillLookupOptions\s*=\s*[^\n]+\s*{(?<body>[\s\S]*?)\n}/)?.groups?.body ?? ''
  if (!skillOptions.includes('readonly signal?: AbortSignal')
    || !runtimeSkillOptions.includes('readonly signal: AbortSignal')) {
    fail('legacy skill lookup must remain optional-signal compatible while versioned plugin operations require cancellation')
  }
  const capabilityAuthor = readFileSync(join(contractRoot, 'consumers/capability-author.ts'), 'utf8')
  for (const proof of [
    'defineCredentialSource({',
    'defineCredentialStore<',
    'defineMemoryStore({',
    'defineObservationExporter({',
    'exampleUsageEstimator',
    "id: 'example-usage-estimator'",
    'async ready(signal)',
    'defineToolSource({',
    'snapshot(options)',
    "revision: 'example-tools-v1'",
    'tools: Object.freeze([clock])',
    'defineAgent({',
    'defineSkill({',
    'defineSkillProviderPlugin(',
    "revision: 'example-skills-v1'",
    "locator: { id: 'research', version: 1 }",
    'isResearchReference(reference)',
    'defineTool(',
    'memory: {',
    "bindingId: 'default-conversation-memory'",
    "scope: { kind: 'conversation', namespace: 'default' }",
    'createTenantMemorySession(',
    'bindingId: memoryBindingId',
    "requirement: 'required'",
    'batch.runRecords.some',
    'acceptedRunIds:',
    "supportedBoundaries: ['none']",
    'call => call.attempts',
    "context.logger?.debug('clock tool invoked'",
  ]) {
    if (!capabilityAuthor.includes(proof)) fail(`capability author journey lacks '${proof}'`)
  }
  const providerExtensionAuthor = readFileSync(
    join(contractRoot, 'consumers/provider-extension-author.ts'),
    'utf8',
  )
  if (!providerExtensionAuthor.includes(
    "native_tools: request.options.tools?.filter(tool => 'type' in tool && tool.type === 'native')",
  )) {
    fail('provider extension author journey does not prove native-tool transport access')
  }
  for (const helper of [
    'defineModelProviderPlugin',
    'defineCredentialSource',
    'defineCredentialStore',
    'defineSkillProvider',
    'defineMemoryStore',
    'defineObservationExporter',
    'defineToolSource',
  ]) {
    if (!coreDeclaration.includes(helper)) fail(`core capability-author contract does not expose '${helper}'`)
  }
  const providerAuthor = readFileSync(join(contractRoot, 'consumers/provider-author.ts'), 'utf8')
  for (const proof of [
    'defineModelProviderPlugin({',
    "routes: ['example']",
    'registrar.registerAdapter(adapter)',
  ]) {
    if (!providerAuthor.includes(proof)) {
      fail(`provider author journey lacks declarative composition proof '${proof}'`)
    }
  }

  const skillFilesystemDeclaration = readFileSync(
    join(contractRoot, 'packages/skill-filesystem/index.d.ts'),
    'utf8',
  )
  for (const field of [
    'export interface FileSystemSkillsOptions',
    'readonly roots?: readonly (string | FileSystemSkillRoot)[]',
    'readonly includeProjectAgents?: boolean',
    'readonly includeProjectDsh?: boolean',
    'readonly includeUserAgents?: boolean',
    'readonly maxCandidates?: number',
    'readonly maxRootEntries?: number',
    'readonly onIo?: (event: FileSystemSkillIoEvent) => void',
    'export declare function fileSystemSkills',
    'export declare function fileSystemSkillProviderPlugin',
    'export declare function discoverFileSystemSkills',
  ]) {
    if (!skillFilesystemDeclaration.includes(field)) {
      fail(`filesystem skill factory contract does not expose '${field}'`)
    }
  }
  const mcpClientDeclaration = readFileSync(join(contractRoot, 'packages/mcp/index.d.ts'), 'utf8')
  const mcpNodeClientDeclaration = readFileSync(join(contractRoot, 'packages/mcp-node/index.d.ts'), 'utf8')
  for (const field of ['connectMcpHttp', 'createMcpHttpClient']) {
    if (!mcpClientDeclaration.includes(field)) fail(`MCP HTTP contract does not expose '${field}'`)
  }
  for (const field of ['connectMcpStdio', 'createMcpStdioClient']) {
    if (!mcpNodeClientDeclaration.includes(field)) fail(`MCP stdio contract does not expose '${field}'`)
  }
  const capabilityFactoryFields: Readonly<Record<string, readonly string[]>> = {
    'observability-browser': [
      'export interface IndexedDbObservationExporterOptions',
      'readonly indexedDB?: IDBFactory',
      'readonly maxEvents?: number',
      'readonly maxBytes?: number',
      'export declare function indexedDbObservationExporter',
    ],
    'observability-fetch': [
      'export interface FetchObservationExporterOptions',
      'readonly endpoint: string | URL',
      'readonly headers?: Readonly<Record<string, string>>',
      'readonly maxAttempts?: number',
      'readonly maxBatchBytes?: number',
      'readonly maxAckBytes?: number',
      'export declare function fetchObservationExporter',
    ],
    'observability-node': [
      "export type JournalDurabilityMode = 'operational' | 'reliable' | 'audit'",
      'export interface JsonlObservationJournalOptions',
      'readonly maxSegmentBytes?: number',
      'readonly maxRetainedBytes?: number',
      'readonly syncIntervalMs?: number',
      'export declare function jsonlObservationExporter',
    ],
    'observability-otel': [
      'export interface OpenTelemetryBridgeOptions',
      'readonly tracer: Tracer',
      'readonly meter: Meter',
      'export interface OpenTelemetryBridge',
      "readonly openSpan: ObservationPort['openSpan']",
      'readonly processor: ObservationProcessor',
      'export declare function createOpenTelemetryBridge',
      'Caller owns the supplied OTel providers',
    ],
  }
  for (const [capability, fields] of Object.entries(capabilityFactoryFields)) {
    const declaration = readFileSync(join(contractRoot, `packages/${capability}/index.d.ts`), 'utf8')
    if (capability === 'observability-otel'
      && declaration.includes('openTelemetryObservationExporter')) {
      fail('OpenTelemetry bridge must not be misdeclared as a batch observation exporter')
    }
    for (const field of fields) {
      if (!declaration.includes(field)) {
        fail(`${capability} composition contract does not expose '${field}'`)
      }
    }
  }

}
// @ts-nocheck
