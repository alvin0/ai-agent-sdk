/** Node-only MCP stdio client transport. */

import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio'
import {
  McpConnectionError,
  McpClientConnection,
  type McpClientLifecycleOptions,
} from '@ai-agent-sdk/mcp/client'

export { McpConnectionError } from '@ai-agent-sdk/mcp/client'
export type { McpCloseReport } from '@ai-agent-sdk/mcp/client'

/** Stdio-specialized alias retained so normal Node recipes name their transport. */
export interface McpStdioConnection extends McpClientConnection {}

export interface McpStdioClientOptions extends McpClientLifecycleOptions, StdioServerParameters {}

/** Construct a supervised stdio client without spawning the child yet. */
export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioConnection {
  const {
    command, args, env, stderr, cwd, maxBufferSize,
    ...lifecycle
  } = options
  if (command.trim().length === 0) throw new TypeError('MCP stdio command must not be empty')
  return new McpClientConnection(lifecycle, () => new StdioClientTransport({
    command,
    ...(args === undefined ? {} : { args: [...args] }),
    ...(env === undefined ? {} : { env: { ...env } }),
    ...(stderr === undefined ? {} : { stderr }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(maxBufferSize === undefined ? {} : { maxBufferSize }),
  }), { integrationFamily: 'mcp-stdio-client' })
}

/** Spawn, negotiate, discover tools, and return a ready stdio client. */
export async function connectMcpStdio(options: McpStdioClientOptions): Promise<McpStdioConnection> {
  const connection = createMcpStdioClient(options)
  try {
    await connection.connect()
    return connection
  } catch (error: unknown) {
    const cleanup = await connection.closeWithReport()
    throw new McpConnectionError(
      connection.state.status === 'connecting' ? 'handshake' : 'unknown',
      {
        code: 'MCP_CONNECT_FAILED', stage: 'stdio-connect', message: 'MCP stdio connection startup failed',
        usageCoverage: { logicalCalls: 0, attempts: 0, complete: 0, partial: 0, estimated: 0,
          missing: 0, notApplicable: 0, possiblyBilledAttemptsWithoutUsage: 0 },
        possiblyBilledAttemptsWithoutUsage: 0,
      },
      cleanup,
      error,
    )
  }
}
