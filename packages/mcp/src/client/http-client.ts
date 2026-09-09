import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type SSEClientTransportOptions,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/client'
import type { McpHttpClientOptions } from './api-types.ts'
import type { McpTransport } from './public-types.ts'
import { McpClientConnection } from './connection.ts'
import { McpConnectionError, connectionFailureStage } from './result.ts'
import { mcpSupportError } from '../common/support-error.ts'
import {
  createGuardedMcpFetch,
  mergeHeaders,
  snapshotHttpSecurityOptions,
  validateHttpEndpoint,
} from './http-security.ts'
import { authenticationKindOf } from './runtime-helpers.ts'

/** Construct an HTTP client without opening the connection yet. */
export function createMcpHttpClient(options: McpHttpClientOptions): McpClientConnection {
  const security = snapshotHttpSecurityOptions(options)
  const url = validateHttpEndpoint(options.url, security)
  const {
    url: _url, fetch: injectedFetch, headers, transport, legacySse,
    allowedOrigins: _allowedOrigins, requireHttps: _requireHttps,
    allowPrivateNetwork: _allowPrivateNetwork, allowRedirects: _allowRedirects,
    validateEndpoint: _validateEndpoint, maxTransportBytes: _maxTransportBytes,
    ...lifecycle
  } = options
  const legacyOptions = legacySse === false ? undefined : legacySse
  const primaryFactory = (): McpTransport => {
    const requestInit = { ...transport?.requestInit }
    if (headers !== undefined) requestInit.headers = mergeHeaders(transport?.requestInit?.headers, headers)
    const guardedFetch = createGuardedMcpFetch(transport?.fetch ?? injectedFetch ?? globalThis.fetch, security)
    return new StreamableHTTPClientTransport(url, {
      ...transport, fetch: guardedFetch,
      ...(Object.keys(requestInit).length === 0 ? {} : { requestInit }),
    } as StreamableHTTPClientTransportOptions) as unknown as McpTransport
  }
  const fallbackFactory = legacySse === false ? undefined : (): McpTransport => {
    const fallbackUrl = validateHttpEndpoint(legacyOptions?.url ?? url, security)
    const fallbackOptions = legacyOptions?.transport
    const requestInit = { ...fallbackOptions?.requestInit }
    if (headers !== undefined) requestInit.headers = mergeHeaders(fallbackOptions?.requestInit?.headers, headers)
    const guardedFetch = createGuardedMcpFetch(
      fallbackOptions?.fetch ?? transport?.fetch ?? injectedFetch ?? globalThis.fetch,
      security,
    )
    return new SSEClientTransport(fallbackUrl, {
      ...fallbackOptions,
      ...(fallbackOptions?.authProvider === undefined && transport?.authProvider !== undefined
        ? { authProvider: transport.authProvider } : {}),
      fetch: guardedFetch,
      ...(Object.keys(requestInit).length === 0 ? {} : { requestInit }),
    } as SSEClientTransportOptions) as unknown as McpTransport
  }
  return new McpClientConnection(lifecycle, primaryFactory, {
    authenticationKind: authenticationKindOf(
      transport?.authProvider,
      mergeHeaders(transport?.requestInit?.headers, headers),
    ),
    ...(fallbackFactory === undefined ? {} : { fallbackTransportFactory: fallbackFactory }),
    integrationFamily: 'mcp-http-client',
  })
}

/** Construct and fully initialize an HTTP client. */
export async function connectMcpHttp(options: McpHttpClientOptions): Promise<McpClientConnection> {
  const connection = createMcpHttpClient(options)
  try { await connection.connect(); return connection }
  catch (error: unknown) {
    const stage = connectionFailureStage(connection.state.status)
    const cleanup = await connection.closeWithReport()
    throw new McpConnectionError(
      stage,
      mcpSupportError('MCP_CONNECT_FAILED', stage, 'MCP connection startup failed'),
      cleanup,
      error,
    )
  }
}
