import {
  McpClientConnection,
  McpRemoteToolError,
  connectMcpHttp,
  createMcpHttpClient,
  resolveMcpReconnectOptions,
  type McpAuthenticationKind,
  type McpAuthorizationState,
  type McpClientLifecycleOptions,
  type McpClientRuntimeOptions,
  type McpClientState,
  type McpClientStatus,
  type McpHttpClientOptions,
  type McpOAuthCallbackOptions,
  type McpProtocolState,
  type McpReconnectOptions,
  type McpToolResultValue,
  type McpTransportFactory,
  type McpTransportKind,
  type ResolvedMcpReconnectOptions,
} from '@compat/mcp-client'
import {
  createSdkMcpHandler,
  createSdkMcpServer,
  type McpAgentSessionContext,
  type McpAgentTool,
  type McpServerErrorContext,
  type SdkMcpServerOptions,
} from '@compat/mcp-server'
import {
  connectMcpStdio,
  createMcpStdioClient,
  type McpStdioClientOptions,
} from '@compat/mcp-node-client'
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  serveSdkMcpStdio,
  toNodeHandler,
  type NodeMcpRequestHandler,
  type ToNodeHandlerOptions,
} from '@compat/mcp-node-server'

export type McpCompatibilityTypeInventory = [
  McpAuthenticationKind,
  McpAuthorizationState,
  McpClientConnection,
  McpClientLifecycleOptions,
  McpClientRuntimeOptions,
  McpClientState,
  McpClientStatus,
  McpHttpClientOptions,
  McpOAuthCallbackOptions,
  McpProtocolState,
  McpReconnectOptions,
  McpToolResultValue,
  McpTransportFactory,
  McpTransportKind,
  ResolvedMcpReconnectOptions,
  McpAgentSessionContext,
  McpAgentTool,
  McpServerErrorContext,
  SdkMcpServerOptions,
  McpStdioClientOptions,
  NodeMcpRequestHandler,
  ToNodeHandlerOptions,
]

export type McpCompatibilityValueInventory = [
  typeof McpClientConnection,
  typeof McpRemoteToolError,
  typeof connectMcpHttp,
  typeof createMcpHttpClient,
  typeof resolveMcpReconnectOptions,
  typeof createSdkMcpHandler,
  typeof createSdkMcpServer,
  typeof connectMcpStdio,
  typeof createMcpStdioClient,
  typeof hostHeaderValidation,
  typeof localhostHostValidation,
  typeof localhostOriginValidation,
  typeof originValidation,
  typeof serveSdkMcpStdio,
  typeof toNodeHandler,
]

const httpOptions: McpHttpClientOptions = {
  serverName: 'compatibility-http',
  url: 'https://mcp.example.test/rpc',
  reconnect: { enabled: true, maxAttempts: 3 },
  maxTools: 100,
  maxCatalogBytes: 1024 * 1024,
  maxToolResultBytes: 1024 * 1024,
}

const stdioOptions: McpStdioClientOptions = {
  serverName: 'compatibility-stdio',
  command: 'fixture-command',
  args: ['--stdio'],
}

/** Representative advanced client source that retains the original close type. */
export async function exerciseMcpClient(
  connection: McpClientConnection,
): Promise<void> {
  const closing: Promise<void> = connection.close()
  await connection.refreshTools()
  await connection.finishOAuth(
    new URLSearchParams('code=fixture'),
    { expectedState: 'fixture-state' },
  )
  await connection.withClient(async (_client, signal) => {
    signal.throwIfAborted()
  })
  void connection.state.error
  void connection.tools
  void resolveMcpReconnectOptions(httpOptions.reconnect)
  void createMcpHttpClient(httpOptions)
  void connectMcpHttp(httpOptions)
  void createMcpStdioClient(stdioOptions)
  void connectMcpStdio(stdioOptions)
  await closing
}

export function exerciseMcpServer(options: SdkMcpServerOptions): void {
  void createSdkMcpServer(options)
  void createSdkMcpHandler(options)
  void serveSdkMcpStdio(options)
  void hostHeaderValidation
  void localhostHostValidation
  void localhostOriginValidation
  void originValidation
  void toNodeHandler
}
