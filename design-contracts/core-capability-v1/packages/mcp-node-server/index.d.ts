import type {
  ServeStdioOptions,
  StdioServerHandle,
} from '@modelcontextprotocol/server/stdio'
import type {
  NodeMcpRequestHandler,
  ToNodeHandlerOptions,
} from '@modelcontextprotocol/node'
import type {
  McpWebServer,
  SdkMcpServerOptions,
} from '@ai-agent-sdk/mcp-server'
import type { SdkLogger } from '@ai-agent-sdk/core/observability'
import type { SupportSafeError } from '@ai-agent-sdk/core/agent'

export {
  createMcpServer,
  type McpServerDefinition,
  type McpWebServer,
} from '@ai-agent-sdk/mcp-server'

export type { NodeMcpRequestHandler, ToNodeHandlerOptions }
export {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node'

/** Existing advanced stdio server entry, moved under P0-14. */
export declare function serveSdkMcpStdio(
  options: SdkMcpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle

export interface McpNodeServerCloseReport {
  readonly state: 'closed'
  readonly deadlineReached: boolean
  readonly unsettledRequests: number
  readonly error?: SupportSafeError
}

export interface McpNodeServerHandle {
  close(
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpNodeServerCloseReport>
}

export declare function serveMcpStdio(
  server: McpWebServer,
  options?: { readonly closeTimeoutMs?: number; readonly logger?: SdkLogger },
): McpNodeServerHandle

export declare function toNodeMcpHandler(
  server: McpWebServer,
): (request: unknown, response: unknown) => Promise<void>
