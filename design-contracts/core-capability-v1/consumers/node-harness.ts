import { fileCodexCredentialStore } from '@ai-agent-sdk/auth-node/codex'
import {
  createAgentRuntime,
  fixedApprovalBroker,
  type RuntimeAgentResponse,
  type DiagnosticSnapshot,
  type RuntimeCloseReport,
} from '@ai-agent-sdk/core'
import {
  connectMcpStdio,
  McpConnectionError,
  type McpCloseReport,
  type McpStdioConnection,
} from '@ai-agent-sdk/mcp-node'
import { jsonlObservationExporter } from '@ai-agent-sdk/observability-node'
import { codexPlugin } from '@ai-agent-sdk/provider-codex'
import { fileSystemSkillProviderPlugin } from '@ai-agent-sdk/skill-filesystem'

export interface NodeHarnessResult {
  readonly response: RuntimeAgentResponse
  readonly diagnostics: DiagnosticSnapshot
  readonly closeReport: RuntimeCloseReport
  readonly mcpCloseReport: McpCloseReport
}

export async function runNodeHarness(workspace: string): Promise<NodeHarnessResult> {
  const runtime = await createAgentRuntime({
    providers: [codexPlugin({ authStore: fileCodexCredentialStore() })],
    observability: {
      content: 'none',
      exporters: [
        {
          exporter: jsonlObservationExporter({
            rootDir: `${workspace}/agent-events`,
            mode: 'reliable',
            maxSegmentBytes: 64 * 1024 * 1024,
            maxRetainedBytes: 1024 * 1024 * 1024,
            syncIntervalMs: 100,
          }),
          ownership: 'owned',
          requirement: 'required',
          boundary: 'local-durable',
        },
      ],
    },
  })
  let mcp: McpStdioConnection | undefined
  let response: RuntimeAgentResponse | undefined
  let diagnostics: DiagnosticSnapshot | undefined
  let closeReport: RuntimeCloseReport | undefined
  let mcpCloseReport: McpCloseReport | undefined
  try {
    mcp = await connectMcpStdio({
      serverName: 'workspace-tools',
      command: 'example-mcp-server',
      cwd: workspace,
      logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
    })
    const agent = runtime.agent({
      id: 'coding-agent',
      model: { provider: 'codex', id: 'gpt-5.6-luna' },
      instructions: 'Inspect the workspace and make evidence-backed changes.',
      skills: [fileSystemSkillProviderPlugin({
        id: 'workspace-skills',
        roots: [{ path: workspace, source: 'workspace' }],
        maxCandidates: 1_024,
        maxRootEntries: 4_096,
        onIo(event) { void event.bytesRead },
      })],
      toolSources: [mcp],
    })
    const reviewer = runtime.agent({
      id: 'review-agent',
      model: { provider: 'codex', id: 'gpt-5.6-luna' },
      instructions: 'Review evidence without changing the workspace.',
    })
    const team = runtime.team({
      id: 'coding-team',
      members: [
        { name: 'coder', agent, role: 'lead' },
        { name: 'reviewer', agent: reviewer, role: 'peer' },
      ],
    })
    try {
      void team.memberNames
      const session = agent.createSession({
        approvals: fixedApprovalBroker('deny'),
        interceptors: [{
          name: 'require-write-approval',
          async before(call, next) {
            return call.toolName.startsWith('write')
              ? { kind: 'ask', reason: 'workspace mutation' }
              : next()
          },
        }],
        usagePolicy: { onMissing: 'fail' },
      })
      response = await session.run('Audit this repository.')
      void response.report.operationCounts['provider-attempt']
      void response.report.usage.coverage.possiblyBilledAttemptsWithoutUsage
      diagnostics = runtime.diagnostics()
      void diagnostics.observationHealth.integrationEvidence.filtered
      void diagnostics.observationHealth.integrationEvidence.dropped
    } finally {
      await team.close()
    }
  } catch (error: unknown) {
    if (error instanceof McpConnectionError) {
      void error.failure.code
      void error.cleanup.error
    }
    throw error
  } finally {
    try {
      closeReport = await runtime.close()
      void closeReport.observationHealth.integrationEvidence.rejected
    } finally {
      if (mcp !== undefined) {
        mcpCloseReport = await mcp.closeWithReport()
      }
    }
  }
  if (response === undefined || diagnostics === undefined
    || closeReport === undefined || mcpCloseReport === undefined) {
    throw new Error('Node harness completed without a terminal runtime report')
  }
  return { response, diagnostics, closeReport, mcpCloseReport }
}
