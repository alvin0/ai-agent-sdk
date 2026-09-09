/** Node-only MCP stdio and node:http server hosts. */

import { StdioServerTransport, serveStdio,
  type ServeStdioOptions, type StdioServerHandle } from '@modelcontextprotocol/server/stdio'
import {
  hostHeaderValidation, localhostHostValidation, localhostOriginValidation,
  originValidation, toNodeHandler, type NodeMcpRequestHandler, type ToNodeHandlerOptions,
} from '@modelcontextprotocol/node'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/observability'
import {
  createSdkMcpServer, type McpWebServer, type SdkMcpRequestContext,
  type SdkMcpServer, type SdkMcpServerOptions,
} from '@alvin0/ai-agent-sdk-mcp-server'
import { createReportedServerClose, type McpNodeServerCloseReport } from './server/close.ts'
import { ObservedStdioTransport } from './server/observed-transport.ts'
import { MCP_NODE_SERVER_DEFAULTS } from './server/config.ts'

export {
  createMcpServer, type McpServerDefinition, type McpWebServer,
} from '@alvin0/ai-agent-sdk-mcp-server'
export type { NodeMcpRequestHandler, ToNodeHandlerOptions }
export {
  hostHeaderValidation, localhostHostValidation, localhostOriginValidation,
  originValidation, toNodeHandler,
}
export type { McpNodeServerCloseReport }

const MCP_WEB_SERVER_FACTORY = Symbol.for('ai-agent-sdk.mcp-web-server.factory.v1')
type InternalFactory = (request: SdkMcpRequestContext,
  family: 'mcp-web-server' | 'mcp-stdio-server') => SdkMcpServer

export interface McpNodeServerHandle {
  close(options?: { readonly signal?: AbortSignal }): Promise<McpNodeServerCloseReport>
}

/** Existing advanced stdio server entry, retained on the dedicated server package. */
export function serveSdkMcpStdio(
  options: SdkMcpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle {
  return serveStdio(request => createSdkMcpServer({
    ...options, integrationFamily: 'mcp-stdio-server',
  }, request as SdkMcpRequestContext) as never, serveOptions)
}

/** Host a preferred inert server over stdio and expose bounded, idempotent cleanup evidence. */
export function serveMcpStdio(
  server: McpWebServer,
  options: { readonly closeTimeoutMs?: number; readonly logger?: SdkLogger } = {},
): McpNodeServerHandle {
  const factory = serverFactory(server)
  const closeTimeoutMs = positiveTimeout(options.closeTimeoutMs ?? MCP_NODE_SERVER_DEFAULTS.closeTimeoutMs)
  const transport = new ObservedStdioTransport(new StdioServerTransport(), options.logger)
  const upstream = serveStdio(
    request => factory(request as SdkMcpRequestContext, 'mcp-stdio-server') as never,
    { transport },
  )
  return Object.freeze({ close: createReportedServerClose(
    upstream, transport, closeTimeoutMs, options.logger,
  ) })
}

/** Adapt a preferred Web-standard server for node:http, Express, or Fastify. */
export function toNodeMcpHandler(server: McpWebServer): NodeMcpRequestHandler {
  if (typeof server?.handle !== 'function') throw new TypeError('Invalid MCP Web server')
  return toNodeHandler({ fetch: request => server.handle(request) })
}

function serverFactory(server: McpWebServer): InternalFactory {
  if ((typeof server !== 'object' || server === null) && typeof server !== 'function') {
    throw new TypeError('Invalid MCP Web server')
  }
  const descriptor = Object.getOwnPropertyDescriptor(server, MCP_WEB_SERVER_FACTORY)
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError('serveMcpStdio requires a server created by createMcpServer')
  }
  return descriptor.value as InternalFactory
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('closeTimeoutMs must be a positive safe integer')
  return value
}
