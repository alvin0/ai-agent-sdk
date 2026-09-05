import type { AgentRuntime } from '@ai-agent-sdk/core'
import type { A2AAgentLink as A2aClientHandle } from '@ai-agent-sdk/a2a/client'
import type { DefinedAgentA2AServer as A2aServerHandle } from '@ai-agent-sdk/a2a/server'
import {
  connectMcpHttp,
  type McpClientConnection,
} from '@ai-agent-sdk/mcp/client'
import { createMcpServer } from '@ai-agent-sdk/mcp/server'
import type { McpServerDefinition } from '@ai-agent-sdk/mcp-server'
import { jsonlObservationExporter } from '@ai-agent-sdk/observability-node/journal'
import '@ai-agent-sdk/observability-node/diagnostic'

export const retainedSubpathRouteProof = {
  runtime: undefined as unknown as AgentRuntime,
  a2aClient: undefined as unknown as A2aClientHandle,
  a2aServer: undefined as unknown as A2aServerHandle,
  mcpConnection: undefined as unknown as McpClientConnection,
  mcpServerDefinition: undefined as unknown as McpServerDefinition,
  connectMcpHttp,
  createMcpServer,
  jsonlObservationExporter,
}
