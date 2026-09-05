import { createMcpHttpClient } from '@ai-agent-sdk/mcp'
import { createMcpStdioClient } from '@ai-agent-sdk/mcp-node'
import { jsonlObservationExporter } from '@ai-agent-sdk/observability-node'
import { fileSystemSkillProviderPlugin } from '@ai-agent-sdk/skill-filesystem'

/** Compile the full Node/additive option bags without acquiring their resources. */
export function createInertAdditiveCapabilities(
  workspace: string,
  fetch: typeof globalThis.fetch,
) {
  const skills = fileSystemSkillProviderPlugin({
    id: 'workspace-skills', roots: [{ path: workspace, source: 'workspace' }],
    cwd: workspace, includeProjectAgents: true, includeProjectDsh: true,
    includeUserAgents: false, maxCandidates: 1_024, maxRootEntries: 4_096,
    onIo(event) { void event.entriesScanned },
  })
  const http = createMcpHttpClient({
    serverName: 'remote-tools', url: 'https://example.test/mcp', fetch,
    reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 5_000, maxAttempts: 4 },
    protocol: 'auto', prefixToolNames: true, toolCallTimeoutMs: 30_000,
    operationTimeoutMs: 10_000, closeTimeoutMs: 5_000, maxTools: 1_024,
    maxCatalogBytes: 1_048_576, maxToolResultBytes: 4_194_304,
    allowedOrigins: ['https://example.test'], requireHttps: true,
    allowPrivateNetwork: false, allowRedirects: false, maxTransportBytes: 4_194_304,
  })
  const stdio = createMcpStdioClient({
    serverName: 'local-tools', command: 'example-mcp-server', cwd: workspace,
    reconnect: false, operationTimeoutMs: 10_000, closeTimeoutMs: 5_000,
    maxTools: 1_024, maxCatalogBytes: 1_048_576, maxToolResultBytes: 4_194_304,
  })
  const journal = jsonlObservationExporter({
    id: 'node-journal', rootDir: `${workspace}/events`, mode: 'reliable',
    maxSegmentBytes: 64 * 1024 * 1024, maxRetainedBytes: 1024 * 1024 * 1024,
    acknowledgedRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    syncIntervalMs: 100, syncRecordCount: 256,
    now: () => new Date(), segmentId: () => 'fixed-segment',
  })
  return { skills, http, stdio, journal }
}
