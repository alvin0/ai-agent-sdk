import {
  createAgentRuntime,
  createUserInputBroker,
  type RuntimeAgentResponse,
  type RuntimeAgentRunEvent,
  type DiagnosticSnapshot,
  type RuntimeCloseReport,
  type ToolDefinition,
} from '@ai-agent-sdk/core'
import {
  connectMcpHttp,
  McpConnectionError,
  type McpClientConnection,
  type McpCloseReport,
} from '@ai-agent-sdk/mcp'
import { fetchObservationExporter } from '@ai-agent-sdk/observability-fetch'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

export interface EdgeResearchResult {
  readonly response: RuntimeAgentResponse
  readonly diagnostics: DiagnosticSnapshot
  readonly closeReport: RuntimeCloseReport
  readonly mcpCloseReport: McpCloseReport
}

export async function runEdgeWithCapabilities(
  apiKey: string,
  webSearch: ToolDefinition,
  onEvent: (event: RuntimeAgentRunEvent) => void,
): Promise<EdgeResearchResult> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey })],
    observability: {
      content: 'none',
      exporters: [
        {
          exporter: fetchObservationExporter({
            endpoint: new URL('https://example.test/events'),
            headers: { 'x-tenant': 'public-research' },
            requestTimeoutMs: 10_000,
            maxAttempts: 4,
            maxBatchEvents: 256,
            maxBatchBytes: 512 * 1024,
            maxAckBytes: 64 * 1024,
          }),
          ownership: 'owned',
          requirement: 'required',
          boundary: 'remote-acknowledged',
        },
      ],
    },
  })
  let mcp: McpClientConnection | undefined
  let response: RuntimeAgentResponse | undefined
  let diagnostics: DiagnosticSnapshot | undefined
  let closeReport: RuntimeCloseReport | undefined
  let mcpCloseReport: McpCloseReport | undefined
  try {
    mcp = await connectMcpHttp({
      serverName: 'research',
      url: new URL('https://example.test/mcp'),
      logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
    })
    const agent = runtime.agent({
      id: 'edge-researcher',
      model: { provider: 'openai', id: 'gpt-5.4' },
      instructions: 'Research, audit coverage, then write a sourced report.',
      mode: 'deep-human-in-loop',
      tools: [webSearch],
      nativeTools: [{
        type: 'native',
        name: 'web-search',
        searchContextSize: 'high',
        maxUses: 12,
      }],
      toolChoice: { type: 'native', name: 'web-search' },
      toolSources: [mcp],
    })
    const userInput = createUserInputBroker({ maxPending: 8 })
    const session = agent.createSession({
      userInput,
      usagePolicy: { onMissing: 'fail' },
    })
    const run = session.stream('Research this topic deeply.')
    for await (const event of run) {
      if (event.type === 'tool-result') {
        void event.callId
        void event.status
      }
      if (event.type === 'assistant-native-tool') {
        void event.callId
        void event.status
        void event.input
      }
      if (event.type === 'approval-request' || event.type === 'user-input-request') {
        void event.request.callId
      }
      if (event.type === 'user-input-response') void event.requestId
      if (event.type === 'usage' || event.type === 'error') {
        void event.report.usage.reported.cacheReadTokens
        void event.report.usage.reported.cacheWriteTokens
        void event.report.usage.reported.reasoningTokens
        void event.report.usage.coverage.possiblyBilledAttemptsWithoutUsage
        void event.report.modelCalls.flatMap(call => call.attempts)
        void event.report.delivery.complete
      }
      onEvent(event)
    }
    response = await run.result
    const resumed = agent.resumeSession(session.snapshot(), {
      userInput,
      usagePolicy: { onMissing: 'fail' },
    })
    void resumed.conversationId
    diagnostics = runtime.diagnostics()
    void diagnostics.observationHealth.integrationEvidence.filtered
    void diagnostics.observationHealth.integrationEvidence.dropped
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
    throw new Error('Edge research completed without a terminal runtime report')
  }
  return { response, diagnostics, closeReport, mcpCloseReport }
}
