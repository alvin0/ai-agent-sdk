/** Export SDK tools and agents as a Universal fetch-shaped MCP server. */

import {
  McpServer,
  createMcpHandler,
  type CreateMcpHandlerOptions,
} from '@modelcontextprotocol/server'
import {
  beginIntegrationOperation,
  integrationChildLogger,
  integrationErrorCode,
} from '../common/integration-operation.ts'
import { copyPreferredState } from '../common/preferred-state.ts'
import type {
  SdkMcpHandlerOptions,
  SdkMcpHandlerRequestOptions,
  SdkMcpHttpHandler,
  SdkMcpRequestContext,
  SdkMcpServer,
} from '../common/server-public-types.ts'

export type * from '../common/server-public-types.ts'
export type { McpAgentSessionContext, McpAgentTool, McpServerErrorContext, SdkMcpServerOptions }
  from './advanced-types.ts'
import type { SdkMcpServerOptions } from './advanced-types.ts'
import { assertIdentity, resolveLimits } from './advanced-support.ts'
import { registerExports } from './advanced-registration.ts'
import { serverFamily } from './advanced-calls.ts'

/** Create one MCP server instance for a connection or HTTP request. */
export function createSdkMcpServer(
  options: SdkMcpServerOptions,
  request: SdkMcpRequestContext = { era: 'modern' },
): SdkMcpServer {
  const limits = resolveLimits(options)
  assertIdentity(options.name, 'server name')
  if (options.version.trim().length === 0) throw new TypeError('MCP server version must not be empty')
  const server = new McpServer(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    },
  )
  const names = new Set<string>()
  registerExports({ server, names, options, request }, limits)
  return server as unknown as SdkMcpServer
}

/** Create a fetch-shaped API for hosts that accept Request/Response. */
export function createSdkMcpHandler(
  options: SdkMcpServerOptions,
  handlerOptions?: SdkMcpHandlerOptions,
): SdkMcpHttpHandler {
  const handler = createMcpHandler(
    request => createSdkMcpServer(withRequestLogger(options), request as SdkMcpRequestContext) as unknown as McpServer,
    handlerOptions as CreateMcpHandlerOptions,
  )
  return {
    fetch: async (request: Request, requestOptions?: SdkMcpHandlerRequestOptions) => {
      const operation = beginIntegrationOperation(
        integrationChildLogger(options.logger, 'mcp-server-request'), serverFamily(options), 'request',
      )
      const attempt = operation.attempt(1)
      try {
        const response = await handler.fetch(request, requestOptions as never)
        if (response.status >= 500) {
          attempt.fail(`HTTP_${response.status}`); operation.fail(`HTTP_${response.status}`)
        } else {
          attempt.success(); operation.success()
        }
        return response
      } catch (error: unknown) {
        const code = integrationErrorCode(error)
        attempt.fail(code); operation.fail(code)
        throw error
      }
    },
    close: handler.close,
    notify: handler.notify,
    bus: handler.bus,
  } as unknown as SdkMcpHttpHandler
}

function withRequestLogger(options: SdkMcpServerOptions): SdkMcpServerOptions {
  const logger = integrationChildLogger(options.logger, 'mcp-server-request')
  if (logger === undefined) return options
  const child = { ...options, logger }
  copyPreferredState(options, child)
  return child
}
