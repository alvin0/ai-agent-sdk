/** Node-only MCP stdio transports and HTTP framework adapters. */

import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio'
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
  type NodeMcpRequestHandler,
  type ToNodeHandlerOptions,
} from '@modelcontextprotocol/node'
import {
  McpClientConnection,
  type McpClientLifecycleOptions,
} from '@ai-agent-sdk/mcp/client'
import { createSdkMcpServer, type SdkMcpServerOptions } from '@ai-agent-sdk/mcp/server'

export interface McpStdioClientOptions extends McpClientLifecycleOptions, StdioServerParameters {}

/** Construct a supervised stdio client without spawning the child yet. */
export function createMcpStdioClient(options: McpStdioClientOptions): McpClientConnection {
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
  }))
}

/** Spawn, negotiate, discover tools, and return a ready stdio client. */
export async function connectMcpStdio(options: McpStdioClientOptions): Promise<McpClientConnection> {
  const connection = createMcpStdioClient(options)
  try {
    await connection.connect()
    return connection
  } catch (error: unknown) {
    await connection.close()
    throw error
  }
}

/** Serve the same SDK tool/agent surface over process stdin/stdout. */
export function serveSdkMcpStdio(
  options: SdkMcpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle {
  return serveStdio(request => createSdkMcpServer(options, request), serveOptions)
}

/** Adapt a web-standard SDK MCP handler for node:http, Express, or Fastify. */
export {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
  type NodeMcpRequestHandler,
  type ToNodeHandlerOptions,
}
