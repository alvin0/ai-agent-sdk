import type { AgentRuntime } from '@ai-agent-sdk/core/agent'
import type { ToolCatalog } from '@ai-agent-sdk/core/tools'
import {
  createMcpServer,
  serveMcpStdio,
  type McpNodeServerCloseReport,
  type McpNodeServerHandle,
} from '@ai-agent-sdk/mcp-node-server'

/** Compile-only proof that Node hosting is selected explicitly and remains composable. */
export function createNodeMcpServerHost(
  runtime: AgentRuntime,
  tools?: ToolCatalog,
): McpNodeServerHandle {
  const logger = runtime.logger({ fields: { integration: 'mcp-stdio-server' } })
  const server = createMcpServer({
    id: 'example-node-tools',
    logger,
    ...(tools === undefined ? {} : { tools }),
  })
  return serveMcpStdio(server, { closeTimeoutMs: 5_000, logger })
}

export async function closeNodeMcpServerHost(
  handle: McpNodeServerHandle,
  signal: AbortSignal,
): Promise<McpNodeServerCloseReport> {
  const report = await handle.close({ signal })
  void report.deadlineReached
  void report.unsettledRequests
  return report
}
