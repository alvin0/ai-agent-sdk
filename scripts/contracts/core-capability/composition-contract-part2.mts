// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateCompositionContractPart2(ctx: ContractContext): void {
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
  if (!topology.journeys.some(journey => journey.id === 'browser-observability')) {
    fail('target journeys do not prove Browser IndexedDB plus OpenTelemetry composition')
  }
  const browserObservability = readFileSync(
    join(contractRoot, 'consumers/browser-observability.ts'),
    'utf8',
  )
  for (const proof of [
    'createOpenTelemetryBridge({',
    'openSpan: bridge.openSpan',
    'processors: [bridge.processor]',
    'indexedDbObservationExporter({',
    "ownership: 'owned'",
    "boundary: 'local-durable'",
  ]) {
    if (!browserObservability.includes(proof)) {
      fail(`browser observability journey lacks '${proof}'`)
    }
  }
  if (!topology.journeys.some(journey => journey.id === 'browser-durable-minimal')) {
    fail('target journeys do not prove minimal direct-browser IndexedDB composition')
  }
  const browserDurableMinimal = readFileSync(
    join(contractRoot, 'consumers/browser-durable-minimal.ts'),
    'utf8',
  )
  for (const proof of [
    'indexedDbObservationExporter({',
    "ownership: 'owned'",
    "requirement: 'best-effort'",
    "boundary: 'local-durable'",
  ]) {
    if (!browserDurableMinimal.includes(proof)) {
      fail(`minimal Browser durability journey lacks '${proof}'`)
    }
  }
  if (browserDurableMinimal.includes('@ai-agent-sdk/observability-otel')) {
    fail('minimal Browser durability journey must not require OpenTelemetry')
  }
  const negativeContract = readFileSync(
    join(contractRoot, 'consumers/negative-contract.ts'),
    'utf8',
  )
  for (const proof of [
    'const legacyProvider: ModelProviderPlugin',
    'Normal composition requires inert route claims before setup.',
    'createAgentRuntime({ providers: [legacyProvider] })',
    "openAiPlugin({ apiKey: async () => 'secret' })",
    'Legacy callback overload is advanced-only, not normal runtime composition.',
    'createAgentRuntime({ providers: [legacyCallbackPlugin] })',
    'Persisted skill locators must be JSON-safe values.',
    'Discovery must return an opaque revision with candidates.',
    'Invocation snapshots must be synchronous and atomic.',
    'Bound local tool executable references are immutable.',
    'Bound approval policy cannot be redirected after session binding.',
    'Built-in native tool configuration has no arbitrary host callbacks.',
    'Legacy health has no integration loss counters.',
    'const runtimeHealth: RuntimeObservationHealthSnapshot = legacy',
    'An attempt start must include both attempt identity and number.',
    'const missingAttemptIdentity: IntegrationOperationEvidenceFields',
    'A logical terminal must include status and duration.',
    'const missingTerminalOutcome: IntegrationOperationEvidenceFields',
  ]) {
    if (!negativeContract.includes(proof)) {
      fail(`negative contract does not prove legacy/composable provider split '${proof}'`)
    }
  }
  if (!topology.journeys.some(journey => journey.id === 'provider-extension-author')) {
    fail('target journeys do not prove configurable HTTP provider extension authoring')
  }
  const providerHttpDeclaration = readFileSync(
    join(contractRoot, 'packages/provider-http/index.d.ts'),
    'utf8',
  )
  for (const field of [
    'export declare const HTTP_PROTOCOL_API_VERSION: 1',
    "readonly HEADER_COLLISION: 'HTTP_HEADER_COLLISION'",
    "readonly HEADER_RESERVED: 'HTTP_HEADER_RESERVED'",
    "readonly WIRE_BODY_INVALID: 'HTTP_WIRE_BODY_INVALID'",
    "readonly WIRE_BODY_TOO_LARGE: 'HTTP_WIRE_BODY_TOO_LARGE'",
    "readonly STREAM_MEDIA_TYPE_INVALID: 'HTTP_STREAM_MEDIA_TYPE_INVALID'",
    "readonly SSE_LIMIT_EXCEEDED: 'HTTP_SSE_LIMIT_EXCEEDED'",
    "readonly kind: 'http-wire-protocol'",
    'readonly apiVersion: typeof HTTP_PROTOCOL_API_VERSION',
    'export declare function defineWireProtocol',
    'export type ProtocolJsonObject = Readonly<Record<string, unknown>>',
    ') => ProtocolJsonObject',
    "| { readonly kind: 'bearer'",
    "readonly kind: 'header'",
    "readonly kind: 'dynamic'",
    'readonly signal: AbortSignal',
    'readonly discoverModels?:',
    'readonly maxCatalogModels?: number',
    'readonly maxCatalogBytes?: number',
    'readonly maxSseEvents?: number',
    'readonly maxSseEventChars?: number',
    'readonly catalogStaleTtlMs?: number',
    'readonly catalogFailureBackoffMs?: number',
    'nativeTools?: readonly NativeToolName[]',
    'readonly retryPolicy?: RetryPolicyConfig',
    'readonly requestLogger?: ProviderRequestLogger',
  ]) {
    if (!providerHttpDeclaration.includes(field)) {
      fail(`provider-http extension contract does not expose '${field}'`)
    }
  }
  for (const protocolPackage of ['protocol-responses', 'protocol-anthropic-messages']) {
    const declaration = readFileSync(
      join(contractRoot, `packages/${protocolPackage}/index.d.ts`),
      'utf8',
    )
    for (const field of [
      "readonly kind: 'http-wire-protocol'",
      'readonly apiVersion: 1',
      'readonly endpointPath:',
      'readonly serialize:',
      'readonly translate:',
    ]) {
      if (!declaration.includes(field)) {
        fail(`${protocolPackage} lost executable wire protocol field '${field}'`)
      }
    }
  }
  const extensionAuthor = readFileSync(
    join(contractRoot, 'consumers/provider-extension-author.ts'),
    'utf8',
  )
  for (const proof of [
    'defineWireProtocol({',
    "kind: 'header'",
    "kind: 'dynamic'",
    'defineCredentialSource({',
    'async discoverModels({ signal })',
    "retryPolicy: { mode: 'normal'",
    'defineModelProviderPlugin({',
    'registerAdapter(',
    'Request serialization is synchronous so one prepared call has one frozen body.',
  ]) {
    if (!extensionAuthor.includes(proof)) {
      fail(`provider extension author journey lacks '${proof}'`)
    }
  }

  if (!topology.journeys.some(journey => journey.id === 'official-provider-factories')) {
    fail('target journeys do not prove all official provider plugin factories')
  }
  const officialProviderFields: Readonly<Record<string, readonly string[]>> = {
    'provider-openai': [
      'export interface OpenAiAdapterOptions',
      'export interface OpenAiPluginOptions extends OpenAiAdapterOptions',
      'organization?: string',
      'project?: string',
      'store?: boolean',
      'maxSseEvents?: number',
      'fetch?: typeof globalThis.fetch',
      'export declare function openAiAdapter',
      'export declare function openAiPlugin',
    ],
    'provider-anthropic': [
      'export interface AnthropicAdapterOptions',
      'export interface AnthropicPluginOptions extends AnthropicAdapterOptions',
      'version?: string',
      'beta?: readonly string[]',
      'thinkingBudgets?: ThinkingBudgets',
      'maxSseEventChars?: number',
      'export declare function anthropicAdapter',
      'export declare function anthropicPlugin',
    ],
    'provider-codex': [
      'export interface CodexAdapterOptions',
      'export interface CodexPluginOptions extends CodexAdapterOptions',
      'extends CodexRevisionedAdapterOptions',
      'readonly authStore: CodexCredentialStore',
      'maxCatalogModels?: number',
      'catalogStaleTtlMs?: number',
      'oauth?: CodexOAuthOptions',
      'One provider-plugin-instance cache/session hint; not a conversation boundary.',
      'export declare function codexAdapter',
      'export declare function codexPlugin',
    ],
  }
  for (const [provider, fields] of Object.entries(officialProviderFields)) {
    const declaration = readFileSync(join(contractRoot, `packages/${provider}/index.d.ts`), 'utf8')
    for (const field of fields) {
      if (!declaration.includes(field)) {
        fail(`${provider} recommended factory contract does not expose '${field}'`)
      }
    }
  }
  const officialFactoryJourney = readFileSync(
    join(contractRoot, 'consumers/official-provider-factories.ts'),
    'utf8',
  )
  for (const proof of [
    'openAiPlugin({',
    'anthropicPlugin({',
    'codexPlugin({',
    'defineCredentialStore<CodexAuthFile>({',
    "id: 'openai-gateway'",
    "baseUrl: 'https://openai-gateway.example.test/v1'",
    'maxSseEvents: 50_000',
    'thinkingBudgets:',
    'maxCatalogModels: 2_048',
    "promptCacheKey: 'provider-instance-cache-key'",
  ]) {
    if (!officialFactoryJourney.includes(proof)) {
      fail(`official provider factory journey lacks '${proof}'`)
    }
  }

  for (const provider of ['provider-openai', 'provider-anthropic', 'provider-http']) {
    const declaration = readFileSync(join(contractRoot, `packages/${provider}/index.d.ts`), 'utf8')
    if (!declaration.includes('CredentialInput')) {
      fail(`${provider} must consume the core credential input contract`)
    }
  }
  if (!topology.journeys.some(journey => journey.id === 'provider-catalog-consumer')) {
    fail('target journeys do not prove high-level provider/model catalog ergonomics')
  }
  for (const field of [
    'export type ModelCatalogState =',
    "readonly refresh?: 'if-stale' | 'force'",
    'export interface ModelCatalogSnapshot',
    'export interface RuntimeProviderInfo extends ProviderInfo',
    'readonly route: string',
    'readonly pluginId: string',
    'readonly family: string',
    "export interface RuntimeModelCatalogSnapshot extends Omit<ModelCatalogSnapshot, 'provider'>",
    'readonly provider: RuntimeProviderInfo',
    'readonly state: ModelCatalogState',
    'readonly revision: string',
    'readonly error?: SupportSafeError',
    'listModels(provider: string, signal?: AbortSignal)',
    'providers(): readonly RuntimeProviderInfo[]',
    '): Promise<RuntimeModelCatalogSnapshot>',
    'modelCatalog(',
  ]) {
    if (!coreDeclaration.includes(field)) {
      fail(`high-level model catalog contract does not expose '${field}'`)
    }
  }
  const catalogConsumer = readFileSync(
    join(contractRoot, 'consumers/provider-catalog-consumer.ts'),
    'utf8',
  )
  for (const proof of [
    'runtime.providers()',
    "provider.route === 'openai'",
    "provider.pluginId === 'openai'",
    "provider.family === 'openai'",
    "runtime.modelCatalog('openai'",
    "refresh: 'if-stale'",
    "catalog.state === 'unavailable'",
    "model: { provider: 'openai', id: 'explicit-model' }",
    'const closeReport = await runtime.close()',
    'closeReport.quiescenceEnd',
    "operation.kind === 'model-catalog'",
  ]) {
    if (!catalogConsumer.includes(proof)) {
      fail(`provider catalog consumer journey lacks '${proof}'`)
    }
  }
  const codexProvider = readFileSync(join(contractRoot, 'packages/provider-codex/index.d.ts'), 'utf8')
  if (!codexProvider.includes('CredentialStore<CodexAuthFile>')) {
    fail('provider-codex auth store must use the revisioned core credential-store contract')
  }
  const authNode = readFileSync(join(contractRoot, 'packages/auth-node/index.d.ts'), 'utf8')
  if (!authNode.includes('CredentialSource & (() => string)')) {
    fail('auth-node env credential must return a versioned credential source')
  }

  for (const provider of ['provider-openai', 'provider-anthropic', 'provider-codex']) {
    const declaration = readFileSync(join(contractRoot, `packages/${provider}/index.d.ts`), 'utf8')
    for (const field of ['readonly id?: string', 'readonly routes?: readonly string[]']) {
      if (!declaration.includes(field)) fail(`${provider} contract does not expose '${field}'`)
    }
  }

  const providerFamilies = new Map([
    ['provider-openai', 'openai'],
    ['provider-anthropic', 'anthropic'],
    ['provider-codex', 'codex'],
  ])
  for (const [provider, family] of providerFamilies) {
    const declaration = readFileSync(join(contractRoot, `packages/${provider}/index.d.ts`), 'utf8')
    if (!declaration.includes(`readonly family: '${family}'`)) {
      fail(`${provider} contract does not freeze its provider family identity`)
    }
  }

  if (!topology.journeys.some(journey => journey.id === 'provider-multiple-instances')) {
    fail('target journeys do not prove multiple provider instances and routes')
  }
  const multipleInstances = readFileSync(
    join(contractRoot, 'consumers/provider-multiple-instances.ts'),
    'utf8',
  )
  for (const proof of [
    "provider.route === 'openai-team-a'",
    "provider.pluginId === 'openai-team-a'",
    "provider.family === 'openai'",
    'runtime.modelCatalog(teamA.route)',
    'runtime.modelCatalog(teamB.route)',
  ]) {
    if (!multipleInstances.includes(proof)) {
      fail(`multiple provider instance journey lacks '${proof}'`)
    }
  }
  if (multipleInstances.includes('routes:')) {
    fail('multiple provider instance journey must prove that a custom id infers its default route')
  }
  if (!topology.journeys.some(journey => journey.id === 'adapter-author')) {
    fail('target journeys do not prove direct non-HTTP adapter authoring')
  }
  for (const field of [
    'export declare abstract class ModelAdapter',
    'providerRetryPolicy(provider: string)',
    'listModels(provider: string, signal?: AbortSignal)',
    'modelCatalog(',
    'resolveModel(',
    'prepareCall(',
    'abstract stream(',
    'export interface AdapterRegistrationHandle',
    'replace(routes: readonly string[]): void',
    'export type StreamMiddleware =',
    'use(middleware: StreamMiddleware): () => void',
    'readonly startProviderAttempt?:',
  ]) {
    if (!coreDeclaration.includes(field)) fail(`core direct-adapter contract does not expose '${field}'`)
  }
  if (coreDeclaration.includes("readonly kind: 'model-adapter'")) {
    fail('advanced ModelAdapter must remain marker-free; the composable provider plugin owns the family marker')
  }
  const adapterAuthor = readFileSync(join(contractRoot, 'consumers/adapter-author.ts'), 'utf8')
  for (const proof of [
    'class ExampleDirectAdapter extends ModelAdapter',
    'AsyncIterable<StreamChunk>',
    "type: 'usage'",
    "type: 'finish'",
    "routes: ['direct', 'direct-compatible']",
    "registerAdapter(new ExampleDirectAdapter(), ['direct'])",
    'registration.replace(',
    'registrar.use(',
    'removeMiddleware()',
    'registration()',
  ]) {
    if (!adapterAuthor.includes(proof)) fail(`direct adapter author journey lacks '${proof}'`)
  }

  for (const journeyFile of ['consumers/edge-capabilities.ts', 'consumers/node-harness.ts']) {
    const source = readFileSync(join(contractRoot, journeyFile), 'utf8')
    const runtimeConstruction = source.indexOf('const runtime = await createAgentRuntime')
    const outerTry = source.indexOf('try {', runtimeConstruction)
    const connection = source.indexOf('mcp = await', outerTry)
    const boundLogger = source.indexOf('logger: runtime.logger(', connection)
    const runtimeClose = source.indexOf('await runtime.close()', connection)
    const connectionGuard = source.indexOf('if (mcp !== undefined)', runtimeClose)
    const borrowedClose = source.indexOf('await mcp.closeWithReport()', runtimeClose)
    if (!(runtimeConstruction >= 0
      && outerTry > runtimeConstruction
      && connection > outerTry
      && boundLogger > connection
      && runtimeClose > boundLogger
      && connectionGuard > runtimeClose
      && borrowedClose > connectionGuard)) {
      fail(`${journeyFile} must construct runtime first, bind its logger, and close runtime before borrowed MCP`)
    }
    for (const proof of [
      'closeReport: RuntimeCloseReport',
      'closeReport = await runtime.close()',
      'diagnostics.observationHealth.integrationEvidence.filtered',
      'diagnostics.observationHealth.integrationEvidence.dropped',
      'closeReport.observationHealth.integrationEvidence.rejected',
    ]) {
      if (!source.includes(proof)) fail(`${journeyFile} does not project '${proof}'`)
    }
  }
  const edgeJourney = readFileSync(join(contractRoot, 'consumers/edge-capabilities.ts'), 'utf8')
  for (const proof of [
    "mode: 'deep-human-in-loop'",
    "name: 'web-search'",
    "searchContextSize: 'high'",
    "toolChoice: { type: 'native', name: 'web-search' }",
    'createUserInputBroker(',
    "event.type === 'approval-request'",
    "event.type === 'user-input-response'",
    'agent.resumeSession(session.snapshot()',
    "event.type === 'assistant-native-tool'",
    'event.callId',
    'event.status',
    'event.input',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'possiblyBilledAttemptsWithoutUsage',
    'call => call.attempts',
    'report.delivery.complete',
  ]) {
    if (!edgeJourney.includes(proof)) fail(`Edge capability journey does not project '${proof}'`)
  }
  const edgeMinimal = readFileSync(join(contractRoot, 'consumers/edge-minimal.ts'), 'utf8')
  for (const proof of [
    'signal?: AbortSignal',
    'signal === undefined ? {} : { signal }',
    "serviceName: 'edge-chat'",
    'onEvent(event)',
    'void event.sequence',
  ]) {
    if (!edgeMinimal.includes(proof)) fail(`Edge minimal journey does not prove '${proof}'`)
  }
  const minimalTry = edgeMinimal.indexOf('try {')
  const minimalLog = edgeMinimal.indexOf("runtime.logger({ fields: { app: 'edge-chat' } }).info('runtime ready')")
  const minimalClose = edgeMinimal.indexOf('await runtime.close()', minimalTry)
  if (!(minimalTry >= 0 && minimalLog > minimalTry && minimalClose > minimalLog)) {
    fail('Edge minimal runtime logging must remain inside the runtime lifetime guard')
  }
  if (!adapterAuthor.includes("context?.logger?.debug('direct adapter stream'")) {
    fail('direct adapter author journey does not prove invocation-correlated logging')
  }
  const nodeJourney = readFileSync(join(contractRoot, 'consumers/node-harness.ts'), 'utf8')
  for (const proof of [
    'fileSystemSkillProviderPlugin({',
    "fixedApprovalBroker('deny')",
    'interceptors: [{',
    "kind: 'ask'",
    'runtime.team({',
    'await team.close()',
  ]) {
    if (!nodeJourney.includes(proof)) fail(`Node harness journey does not prove '${proof}'`)
  }
  for (const proof of [
    'export interface RuntimeAgentTeam {',
    'linkAgent(options: LinkAgentOptions): () => void',
    'sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult>',
    "readonly type: 'member-linked'",
    'export interface LinkedAgentSendInput {',
    'Always set by RuntimeAgentTeam; optional for preserved direct transports.',
    'readonly logger?: SdkLogger',
  ]) {
    if (!coreDeclaration.includes(proof)) fail(`runtime team A2A bridge lacks '${proof}'`)
  }
  const a2aClientDeclaration = readFileSync(join(contractRoot, 'packages/a2a/client.d.ts'), 'utf8')
  const a2aRootDeclaration = readFileSync(join(contractRoot, 'packages/a2a/index.d.ts'), 'utf8')
  for (const proof of [
    'export interface A2ALinkableTeam',
    'linkAgent(options: LinkAgentOptions): () => void',
    'team: A2ALinkableTeam',
    'export interface A2AUnlinkReport',
    "readonly status: 'unlinked' | 'failed'",
    'readonly unlinkWithReport: () => A2AUnlinkReport',
  ]) {
    if (!a2aClientDeclaration.includes(proof)) fail(`A2A runtime-team bridge lacks '${proof}'`)
  }
  for (const reportType of ['type A2AUnlinkReport', 'type A2ADisposeReport']) {
    if (!a2aRootDeclaration.includes(reportType)) {
      fail(`A2A root target does not re-export '${reportType}'`)
    }
  }
  const nodeA2aJourney = readFileSync(
    join(contractRoot, 'consumers/node-a2a-runtime-team.ts'),
    'utf8',
  )
  for (const proof of [
    'team: RuntimeAgentTeam',
    'runtime: AgentRuntime',
    "runtime.logger({ fields: { integration: 'a2a-client-link' } })",
    'await linkA2AAgent(team, {',
    'createDefinedAgentA2AServer({ agent, agentCard, logger })',
    'return { unlink, unlinkWithReport }',
    'runtimeReport = await runtime.close({ signal })',
    'a2aReport = unlinkWithReport()',
    "disposeWithReport('runtime closed')",
  ]) {
    if (!nodeA2aJourney.includes(proof)) fail(`A2A runtime-team journey lacks '${proof}'`)
  }
  const a2aRuntimeClose = nodeA2aJourney.indexOf('runtimeReport = await runtime.close({ signal })')
  const a2aUnlink = nodeA2aJourney.indexOf('a2aReport = unlinkWithReport()', a2aRuntimeClose)
  if (!(a2aRuntimeClose >= 0 && a2aUnlink > a2aRuntimeClose)) {
    fail('A2A runtime-team journey must close runtime before its idempotent unlink report')
  }

  const mcpDeclaration = readFileSync(join(contractRoot, 'packages/mcp/index.d.ts'), 'utf8')
  const mcpServerDeclaration = readFileSync(
    join(contractRoot, 'packages/mcp-server/index.d.ts'),
    'utf8',
  )
  const mcpNodeServerDeclaration = readFileSync(
    join(contractRoot, 'packages/mcp-node-server/index.d.ts'),
    'utf8',
  )
  const a2aServerDeclaration = readFileSync(
    join(contractRoot, 'packages/a2a/server.d.ts'),
    'utf8',
  )
  if (!coreDeclaration.includes('export interface ToolSource {')
    || coreDeclaration.includes('interface ToolSourceV1')) {
    fail('tool-source contract must use the stable ToolSource name with an API marker')
  }
  for (const field of [
    'readonly catalogRevision: number',
    'readonly reconnect?: McpReconnectOptions | false',
    'readonly operationTimeoutMs?: number',
    'readonly closeTimeoutMs?: number',
    'readonly maxCatalogBytes?: number',
    'readonly maxToolResultBytes?: number',
    'readonly logger?: SdkLogger',
    'readonly allowedOrigins?: readonly string[]',
    'readonly allowRedirects?: boolean',
    'get state(): McpClientState',
    'readonly tools: ToolCatalog',
    'core composition uses snapshot()',
    'refreshTools(',
    'finishOAuth(',
    'close(): Promise<void>',
    'closeWithReport(',
    'Promise<McpCloseReport>',
    'readonly deadlineReached: boolean',
    'readonly unsettledOperations: number',
    'export declare class McpConnectionError extends Error',
    "readonly code: 'MCP_CONNECT_FAILED'",
    "readonly stage: 'transport' | 'authentication' | 'handshake' | 'catalog' | 'unknown'",
    'readonly failure: SupportSafeError',
    'readonly cleanup: McpCloseReport',
  ]) {
    if (!mcpDeclaration.includes(field)) fail(`MCP target contract does not expose '${field}'`)
  }
  if ((mcpServerDeclaration.match(/readonly logger\?: SdkLogger/g) ?? []).length !== 2) {
    fail('MCP web server target contract must expose optional logger on advanced and preferred definitions')
  }
  if (!mcpNodeServerDeclaration.includes(
    'options?: { readonly closeTimeoutMs?: number; readonly logger?: SdkLogger }',
  )) {
    fail('MCP Node server target contract does not expose an optional stdio-host logger')
  }
  if (!a2aClientDeclaration.includes('readonly logger?: SdkLogger')
    || !a2aServerDeclaration.includes('readonly logger?: SdkLogger')
    || !a2aServerDeclaration.includes('export interface A2ADisposeReport')
    || !a2aServerDeclaration.includes('disposeWithReport(reason?: unknown): Promise<A2ADisposeReport>')) {
    fail('A2A client and server target contracts must both expose optional bound loggers')
  }
  if (!mcpNodeServerDeclaration.includes('readonly error?: SupportSafeError')) {
    fail('MCP Node server close report lacks support-safe failure evidence')
  }
  const mcpClientView = readFileSync(join(contractRoot, 'packages/mcp/client.d.ts'), 'utf8')
  const mcpNodeClientView = readFileSync(join(contractRoot, 'packages/mcp-node/index.d.ts'), 'utf8')
  if (!mcpClientView.includes('McpConnectionError')
    || !mcpNodeClientView.includes('export { McpConnectionError }')) {
    fail('MCP HTTP and stdio recommended routes must both expose failed-connect evidence')
  }
  const integrationLoggingProofs = new Map<string, readonly string[]>([
    ['consumers/edge-mcp-server-host.ts', [
      'runtime: AgentRuntime',
      "runtime.logger({ fields: { integration: 'mcp-web-server' } })",
      'const server = createMcpServer({',
      'logger,',
    ]],
    ['consumers/node-mcp-server-host.ts', [
      'runtime: AgentRuntime',
      "runtime.logger({ fields: { integration: 'mcp-stdio-server' } })",
      'const server = createMcpServer({',
      'return serveMcpStdio(server, { closeTimeoutMs: 5_000, logger })',
    ]],
    ['consumers/node-a2a-runtime-team.ts', [
      'runtime: AgentRuntime',
      "runtime.logger({ fields: { integration: 'a2a-client-link' } })",
      "runtime.logger({ fields: { integration: 'a2a-server' } })",
      'await linkA2AAgent(team, {',
      'createDefinedAgentA2AServer({ agent, agentCard, logger })',
    ]],
  ])
  for (const [journeyFile, proofs] of integrationLoggingProofs) {
    const source = readFileSync(join(contractRoot, journeyFile), 'utf8')
    for (const proof of proofs) {
      if (!source.includes(proof)) {
        fail(`${journeyFile} does not project caller-owned integration logging '${proof}'`)
      }
    }
  }
  for (const journeyFile of ['consumers/edge-capabilities.ts', 'consumers/node-harness.ts']) {
    const source = readFileSync(join(contractRoot, journeyFile), 'utf8')
    for (const proof of [
      'mcpCloseReport = await mcp.closeWithReport()',
      'mcpCloseReport: McpCloseReport',
    ]) {
      if (!source.includes(proof)) fail(`${journeyFile} does not retain '${proof}'`)
    }
  }
}
// @ts-nocheck
