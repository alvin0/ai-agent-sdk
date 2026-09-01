import type { AuthProvider, OAuthClientProvider } from '@modelcontextprotocol/client'
import type { McpClientState } from '@ai-agent-sdk/mcp/client'
import { createMcpHttpClient, type McpClientConnection } from '@ai-agent-sdk/mcp/client'
import type { GitHubMcpCliConfig } from './config.ts'

const READ_TOOLS = ['get_me', 'get_file_contents'] as const
const WRITE_TOOLS = ['get_file_contents', 'create_or_update_file'] as const

export interface GitHubMcpConnectionOptions {
  readonly onStateChange?: (state: McpClientState) => void
  readonly oauthProvider?: OAuthClientProvider
}

export function createGitHubMcpConnection(
  config: GitHubMcpCliConfig,
  options: GitHubMcpConnectionOptions = {},
): McpClientConnection {
  const writing = config.command === 'create-file'
  const tools = writing ? WRITE_TOOLS : READ_TOOLS
  const authProvider: AuthProvider | OAuthClientProvider = config.auth.kind === 'pat'
    ? { token: async () => config.auth.kind === 'pat' ? config.auth.token : undefined }
    : requireOAuthProvider(options.oauthProvider)
  return createMcpHttpClient({
    serverName: 'github',
    url: config.url,
    reconnect: false,
    toolCallTimeoutMs: 60_000,
    toolFilter: { allow: tools },
    headers: {
      'X-MCP-Tools': tools.join(','),
      ...(writing ? {} : { 'X-MCP-Readonly': 'true' }),
    },
    transport: {
      authProvider,
      onInsufficientScope: config.auth.kind === 'oauth' ? 'reauthorize' : 'throw',
    },
    ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }),
  })
}

function requireOAuthProvider(provider: OAuthClientProvider | undefined): OAuthClientProvider {
  if (provider === undefined) throw new TypeError('OAuth configuration requires an OAuthClientProvider')
  return provider
}

export function selectedGitHubTools(command: GitHubMcpCliConfig['command']): readonly string[] {
  return command === 'create-file' ? WRITE_TOOLS : READ_TOOLS
}
