// @ts-nocheck
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { analyzeSourceOwnershipGraph } from '../../source-graph.mts'
import { makeHelpers } from './helpers.mts'
import type { ContractContext } from './context.mts'
import type { Runtime } from './types.mts'

export function validateRecommendedCompositionEntrypoints(ctx: ContractContext): void {
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

  const expected = new Map<string, string>([
    ['@ai-agent-sdk/provider-openai', '@ai-agent-sdk/provider-openai|openAiPlugin|runtime.providers|inert-runtime-owned-registration|application'],
    ['@ai-agent-sdk/provider-anthropic', '@ai-agent-sdk/provider-anthropic|anthropicPlugin|runtime.providers|inert-runtime-owned-registration|application'],
    ['@ai-agent-sdk/provider-codex', '@ai-agent-sdk/provider-codex|codexPlugin|runtime.providers|inert-runtime-owned-registration|application'],
    ['@ai-agent-sdk/provider-http', '@ai-agent-sdk/provider-http|createRuntimeHttpProvider|provider-author.adapter|inert-value|authoring-support'],
    ['@ai-agent-sdk/protocol-responses', '@ai-agent-sdk/protocol-responses|openAiResponsesProtocol|provider-author.protocol|inert-value|authoring-support'],
    ['@ai-agent-sdk/protocol-anthropic-messages', '@ai-agent-sdk/protocol-anthropic-messages|anthropicMessagesProtocol|provider-author.protocol|inert-value|authoring-support'],
    ['@ai-agent-sdk/mcp', '@ai-agent-sdk/mcp|connectMcpHttp|runtime-agent.toolSources|connected-caller-owned|application'],
    ['@ai-agent-sdk/mcp-server', '@ai-agent-sdk/mcp-server|createMcpServer|host.mcp-server|inert-host-mounted|application'],
    ['@ai-agent-sdk/mcp-node', '@ai-agent-sdk/mcp-node|connectMcpStdio|runtime-agent.toolSources|connected-caller-owned|application'],
    ['@ai-agent-sdk/mcp-node-server', '@ai-agent-sdk/mcp-node-server|serveMcpStdio|host.mcp-server|host-owned|application'],
    ['@ai-agent-sdk/skill-filesystem', '@ai-agent-sdk/skill-filesystem|fileSystemSkillProviderPlugin|runtime-agent.skills|borrowed-caller-owned|application'],
    ['@ai-agent-sdk/observability-fetch', '@ai-agent-sdk/observability-fetch|fetchObservationExporter|runtime.observability.exporters|explicit-owned-or-borrowed|application'],
    ['@ai-agent-sdk/observability-browser', '@ai-agent-sdk/observability-browser|indexedDbObservationExporter|runtime.observability.exporters|explicit-owned-or-borrowed|application'],
    ['@ai-agent-sdk/observability-node', '@ai-agent-sdk/observability-node|jsonlObservationExporter|runtime.observability.exporters|explicit-owned-or-borrowed|application'],
    ['@ai-agent-sdk/observability-otel', '@ai-agent-sdk/observability-otel|createOpenTelemetryBridge|runtime.observability.openSpan-processors|borrowed-caller-owned|application'],
    ['@ai-agent-sdk/auth-node', '@ai-agent-sdk/auth-node|envCredential|provider-factory.credentials|borrowed-caller-owned|application'],
    ['@ai-agent-sdk/a2a', '@ai-agent-sdk/a2a/client|linkA2AAgent|runtime-team.linkAgent|borrowed-caller-owned|application'],
  ])
  const expectedProofs = new Map<string, readonly [string, ...string[]]>([
    ['@ai-agent-sdk/provider-openai', ['consumers/edge-minimal.ts', 'providers: [openAiPlugin(']],
    ['@ai-agent-sdk/provider-anthropic', ['consumers/anthropic-minimal.ts', 'providers: [anthropicPlugin(']],
    ['@ai-agent-sdk/provider-codex', ['consumers/codex-injected-minimal.ts', 'providers: [codexPlugin(']],
    ['@ai-agent-sdk/provider-http', ['consumers/provider-author.ts', 'const adapter = createRuntimeHttpProvider(', 'registrar.registerAdapter(adapter)']],
    ['@ai-agent-sdk/protocol-responses', ['consumers/provider-author.ts', 'protocol: openAiResponsesProtocol']],
    ['@ai-agent-sdk/protocol-anthropic-messages', ['consumers/anthropic-provider-author.ts', 'protocol: anthropicMessagesProtocol']],
    ['@ai-agent-sdk/mcp', ['consumers/edge-capabilities.ts', 'mcp = await connectMcpHttp(', 'logger: runtime.logger(', 'toolSources: [mcp]', 'error instanceof McpConnectionError', 'void error.cleanup.error', 'mcpCloseReport = await mcp.closeWithReport()']],
    ['@ai-agent-sdk/mcp-server', ['consumers/edge-mcp-server-host.ts', 'runtime.logger(', 'const server = createMcpServer(', 'logger,', 'return server.handle(request, { signal })']],
    ['@ai-agent-sdk/mcp-node', ['consumers/node-harness.ts', 'mcp = await connectMcpStdio(', 'logger: runtime.logger(', 'toolSources: [mcp]', 'error instanceof McpConnectionError', 'void error.cleanup.error', 'mcpCloseReport = await mcp.closeWithReport()']],
    ['@ai-agent-sdk/mcp-node-server', ['consumers/node-mcp-server-host.ts', 'runtime.logger(', 'return serveMcpStdio(server', 'logger })', 'const report = await handle.close({ signal })', 'void report.unsettledRequests']],
    ['@ai-agent-sdk/skill-filesystem', ['consumers/node-harness.ts', 'skills: [fileSystemSkillProviderPlugin(']],
    ['@ai-agent-sdk/observability-fetch', ['consumers/edge-capabilities.ts', 'exporter: fetchObservationExporter(', "ownership: 'owned'"]],
    ['@ai-agent-sdk/observability-browser', ['consumers/browser-observability.ts', 'exporter: indexedDbObservationExporter(', "ownership: 'owned'"]],
    ['@ai-agent-sdk/observability-node', ['consumers/node-harness.ts', 'exporter: jsonlObservationExporter(', "ownership: 'owned'"]],
    ['@ai-agent-sdk/observability-otel', ['consumers/browser-observability.ts', 'const bridge = createOpenTelemetryBridge(', 'openSpan: bridge.openSpan', 'processors: [bridge.processor]']],
    ['@ai-agent-sdk/auth-node', ['consumers/node-env.ts', 'apiKey: envCredential(']],
    ['@ai-agent-sdk/a2a', ['consumers/node-a2a-runtime-team.ts', 'runtime.logger(', 'await linkA2AAgent(team', 'logger,', 'return { unlink, unlinkWithReport }', 'runtimeReport = await runtime.close({ signal })', 'a2aReport = unlinkWithReport()', "disposeWithReport('runtime closed')"]],
  ])
  assertSameSet(
    'recommended composition entrypoint package coverage',
    new Set(Object.keys(topology.recommendedCompositionEntrypoints)),
    new Set(Object.keys(topology.packages).filter(name => name !== '@ai-agent-sdk/core')),
  )
  assertSameSet(
    'recommended composition entrypoint routes',
    new Set(Object.entries(topology.recommendedCompositionEntrypoints).map(([packageName, entry]) =>
      `${packageName}=${entry.specifier}|${entry.symbol}|${entry.compositionPoint}|${entry.lifecycle}|${entry.audience}`)),
    new Set([...expected].map(([packageName, value]) => `${packageName}=${value}`)),
  )
  assertSameSet(
    'recommended composition proof coverage',
    new Set(Object.keys(topology.recommendedCompositionEntrypoints)),
    new Set(expectedProofs.keys()),
  )
  for (const [packageName, entry] of Object.entries(topology.recommendedCompositionEntrypoints)) {
    if (packageBySpecifier.get(entry.specifier) !== packageName) {
      fail(`recommended entrypoint '${entry.specifier}' is not owned by '${packageName}'`)
    }
    const declarationPath = tsconfig.compilerOptions?.paths?.[entry.specifier]
    const declaration = declarationPath?.[0]
    if (declarationPath?.length !== 1 || declaration === undefined) {
      fail(`recommended entrypoint '${entry.specifier}' has no exact declaration route`)
    }
    const exports = targetDeclarationExportsOf(resolve(contractRoot, declaration))
    if (!exports.has(entry.symbol)) {
      fail(`recommended entrypoint '${entry.specifier}' does not export '${entry.symbol}'`)
    }
    const expectedProof = expectedProofs.get(packageName)
    if (expectedProof === undefined
      || entry.proofFile !== expectedProof[0]
      || JSON.stringify(entry.proofFragments) !== JSON.stringify(expectedProof.slice(1))) {
      fail(`recommended entrypoint '${packageName}' composition proof drifted`)
    }
    const proofPath = resolve(contractRoot, entry.proofFile)
    if (!proofPath.startsWith(`${join(contractRoot, 'consumers')}/`) || !existsSync(proofPath)) {
      fail(`recommended entrypoint '${packageName}' has an invalid proof file`)
    }
    if (!importsOf(proofPath).includes(entry.specifier)) {
      fail(`recommended entrypoint '${packageName}' proof does not import '${entry.specifier}'`)
    }
    const proofSource = readFileSync(proofPath, 'utf8')
    for (const fragment of entry.proofFragments) {
      if (!proofSource.includes(fragment)) {
        fail(`recommended entrypoint '${packageName}' proof lacks '${fragment}'`)
      }
    }
    const proofJourney = topology.journeys.find(journey => journey.file === entry.proofFile)
    if (proofJourney === undefined || !proofJourney.packages.includes(packageName)) {
      fail(`recommended entrypoint '${packageName}' proof is not backed by a direct install journey`)
    }
  }
}
// @ts-nocheck
