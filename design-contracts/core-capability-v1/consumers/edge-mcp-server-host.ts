import type { AgentRuntime } from '@ai-agent-sdk/core/agent'
import type { ToolCatalog } from '@ai-agent-sdk/core/tools'
import {
  createMcpServer,
  type McpWebServer,
} from '@ai-agent-sdk/mcp-server'

/** Universal host proof: Request/Response serving needs no Node transport package. */
export function createEdgeMcpServerHost(
  runtime: AgentRuntime,
  tools?: ToolCatalog,
): McpWebServer {
  const logger = runtime.logger({ fields: { integration: 'mcp-web-server' } })
  const server = createMcpServer({
    id: 'edge-tools',
    logger,
    ...(tools === undefined ? {} : { tools }),
    maxRequestBytes: 256 * 1024,
    maxResponseBytes: 1024 * 1024,
  })
  return server
}

export function handleEdgeMcpRequest(
  server: McpWebServer,
  request: Request,
  signal: AbortSignal,
): Promise<Response> {
  return server.handle(request, { signal })
}
