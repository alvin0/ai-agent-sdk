import { describe, expect, it } from 'vitest'
import * as node from '@ai-agent-sdk/node'
import * as core from '@ai-agent-sdk/core'
import * as agent from '@ai-agent-sdk/agent'
import * as authCodex from '@ai-agent-sdk/auth-node/codex'
import * as authEnv from '@ai-agent-sdk/auth-node/env'
import * as skillFilesystem from '@ai-agent-sdk/skill-filesystem'
import * as mcp from '@ai-agent-sdk/mcp'
import * as mcpNode from '@ai-agent-sdk/mcp-node'
import * as a2a from '@ai-agent-sdk/a2a'
import * as observability from '@ai-agent-sdk/observability'
import * as observabilityFetch from '@ai-agent-sdk/observability-fetch'
import * as observabilityNode from '@ai-agent-sdk/observability-node'
import * as observabilityOtel from '@ai-agent-sdk/observability-otel'
import * as providerAnthropic from '@ai-agent-sdk/provider-anthropic'
import * as providerCodex from '@ai-agent-sdk/provider-codex'
import * as providerOpenAi from '@ai-agent-sdk/provider-openai'

describe('Node facade', () => {
  it('re-exports canonical leaf identities without a second SDK instance', () => {
    expect(node.ModelRegistry).toBe(core.ModelRegistry)
    expect(node.defineAgent).toBe(agent.defineAgent)
    expect(node.ToolRegistry).toBe(agent.ToolRegistry)
    expect(node.fileSystemSkills).toBe(skillFilesystem.fileSystemSkills)
    expect(node.envCredential).toBe(authEnv.envCredential)
    expect(node.codexNodeAdapter).toBe(authCodex.codexNodeAdapter)
    expect(node.codexAdapter).toBe(authCodex.codexAdapter)
    expect(node.anthropicAdapter).toBe(providerAnthropic.anthropicAdapter)
    expect(node.openAiAdapter).toBe(providerOpenAi.openAiAdapter)
    expect(node.universalCodex.codexAdapter).toBe(providerCodex.codexAdapter)
    expect(node.createObservability).toBe(observability.createObservability)
    expect(node.FetchObservationExporter).toBe(observabilityFetch.FetchObservationExporter)
    expect(node.JsonlObservationJournalExporter).toBe(
      observabilityNode.JsonlObservationJournalExporter,
    )
    expect(node.createOpenTelemetryBridge).toBe(observabilityOtel.createOpenTelemetryBridge)
    expect(node.mcp.McpClientConnection).toBe(mcp.McpClientConnection)
    expect(node.mcp.createMcpStdioClient).toBe(mcpNode.createMcpStdioClient)
    expect(node.a2a.A2AAgentLink).toBe(a2a.A2AAgentLink)
  })

  it('does not expose browser lifecycle or IndexedDB capability', () => {
    expect('IndexedDbObservationExporter' in node).toBe(false)
    expect('installBrowserObservabilityLifecycle' in node).toBe(false)
  })
})
