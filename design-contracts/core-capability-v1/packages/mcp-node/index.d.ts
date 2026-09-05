import type {
  McpClientConnection,
  McpClientLifecycleOptions,
} from '@ai-agent-sdk/mcp/client'
import type { StdioServerParameters } from '@modelcontextprotocol/client/stdio'
export { McpConnectionError } from '@ai-agent-sdk/mcp/client'
export type { McpCloseReport } from '@ai-agent-sdk/mcp/client'

export interface McpStdioConnection extends McpClientConnection {}

export interface McpStdioClientOptions
  extends McpClientLifecycleOptions, StdioServerParameters {}

export declare function connectMcpStdio(
  options: McpStdioClientOptions,
): Promise<McpStdioConnection>

export declare function createMcpStdioClient(
  options: McpStdioClientOptions,
): McpStdioConnection
