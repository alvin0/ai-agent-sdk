import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionResult } from '../../src/agent/tool/definition.ts'
import type { JsonObject, JsonValue } from '../../src/core/primitives/json.ts'
import { runGitHubMcpCommand } from '../../test-human/github-mcp/commands.ts'
import { selectedGitHubTools } from '../../test-human/github-mcp/connection.ts'
import {
  GITHUB_MCP_URL,
  parseGitHubMcpArgs,
  type GitHubMcpCliConfig,
} from '../../test-human/github-mcp/config.ts'
import type {
  GitHubMcpToolCaller,
  GitHubMcpToolName,
} from '../../test-human/github-mcp/tools.ts'
import { GitHubOAuthProvider } from '../../test-human/github-mcp/oauth.ts'

describe('GitHub MCP human test', () => {
  it('shows help without requiring or reading a token', () => {
    expect(parseGitHubMcpArgs(['--help'], {})).toEqual({ help: true })
  })

  it('defaults to whoami and resolves credentials only from the environment', () => {
    expect(parseGitHubMcpArgs([], { GITHUB_TOKEN: 'secret' })).toMatchObject({
      help: false,
      command: 'whoami',
      auth: { kind: 'pat', token: 'secret' },
      url: GITHUB_MCP_URL,
    })
    expect(() => parseGitHubMcpArgs([], {})).toThrow(/OAuth authentication requires/i)
    expect(() => parseGitHubMcpArgs(['--token', 'leak-me'], { GITHUB_TOKEN: 'secret' }))
      .toThrow(/unknown option '--token'/)
  })

  it('selects OAuth when app credentials are configured and validates its loopback callback', () => {
    expect(parseGitHubMcpArgs(['whoami', '--auth', 'oauth', '--no-open-browser'], {
      GITHUB_MCP_OAUTH_CLIENT_ID: 'client-id',
      GITHUB_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
    })).toMatchObject({
      auth: {
        kind: 'oauth',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUrl: 'http://127.0.0.1:8765/oauth/callback',
        callbackTimeoutMs: 180_000,
        openBrowser: false,
      },
    })
    expect(() => parseGitHubMcpArgs([
      'whoami', '--auth', 'oauth', '--oauth-redirect-url', 'https://example.com/callback',
    ], {
      GITHUB_MCP_OAUTH_CLIENT_ID: 'client-id',
      GITHUB_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
    })).toThrow(/HTTP loopback URL/)
    expect(() => parseGitHubMcpArgs([
      'whoami', '--auth', 'oauth', '--url', 'https://gateway.example/mcp',
    ], {
      GITHUB_MCP_OAUTH_CLIENT_ID: 'client-id',
      GITHUB_MCP_OAUTH_CLIENT_SECRET: 'client-secret',
    })).toThrow(/official GitHub MCP origin/)
  })

  it('normalizes a repository read without enabling write tools', () => {
    const parsed = parseGitHubMcpArgs([
      'read', '--repo', 'github/github-mcp-server', '--path', 'docs/remote-server.md', '--ref', 'main',
    ], { GITHUB_MCP_TOKEN: 'secret' })
    expect(parsed).toMatchObject({
      command: 'read', owner: 'github', repo: 'github-mcp-server',
      path: 'docs/remote-server.md', ref: 'refs/heads/main',
    })
    expect(selectedGitHubTools('read')).toEqual(['get_me', 'get_file_contents'])
    expect(selectedGitHubTools('create-file')).toEqual(['get_file_contents', 'create_or_update_file'])
  })

  it('requires explicit write authorization and safe targets', () => {
    const base = ['create-file', '--repo', 'acme/widget', '--branch', 'mcp-test', '--path', 'checks/mcp.md']
    expect(() => parseGitHubMcpArgs(base, { GITHUB_TOKEN: 'secret' })).toThrow(/confirm-write/)
    expect(() => parseGitHubMcpArgs([...base, '--confirm-write', '--content', 'a', '--content-file', 'a.md'], {
      GITHUB_TOKEN: 'secret',
    })).toThrow(/either --content or --content-file/)
    expect(() => parseGitHubMcpArgs([
      'create-file', '--repo', 'acme/widget', '--branch', 'mcp-test', '--path', '../escape.md', '--confirm-write',
    ], { GITHUB_TOKEN: 'secret' })).toThrow(/relative repository file path/)
  })

  it('creates plaintext only after a not-found preflight and verifies it', async () => {
    const caller = scriptedCaller([
      failure('GitHub returned 404 Not Found'),
      success('created'),
      success('hello from MCP'),
    ])
    const steps = await runGitHubMcpCommand(writeConfig({ content: 'hello from MCP' }), caller)

    expect(steps.map(step => step.tool)).toEqual([
      'get_file_contents', 'create_or_update_file', 'get_file_contents',
    ])
    expect(caller.calls[1]).toEqual({
      name: 'create_or_update_file',
      args: {
        owner: 'acme', repo: 'widget', path: 'mcp/check.md', branch: 'mcp-test',
        message: 'test: add GitHub MCP human check', content: 'hello from MCP',
      },
    })
    expect(caller.calls[1]?.args).not.toHaveProperty('sha')
  })

  it('refuses to overwrite an existing file', async () => {
    const caller = scriptedCaller([success('already here')])
    await expect(runGitHubMcpCommand(writeConfig({ content: 'replacement' }), caller))
      .rejects.toThrow(/refusing to overwrite/)
    expect(caller.calls).toHaveLength(1)
  })

  it('fails closed when the preflight error does not prove absence', async () => {
    const caller = scriptedCaller([failure('permission denied')])
    await expect(runGitHubMcpCommand(writeConfig({ content: 'new file' }), caller))
      .rejects.toThrow(/could not prove/)
    expect(caller.calls).toHaveLength(1)
  })

  it('generates useful default content when none is supplied', async () => {
    const caller = scriptedCaller([failure('not found'), success('created'), success('verified')])
    await runGitHubMcpCommand(
      writeConfig({}),
      caller,
      () => new Date('2026-08-31T12:34:56.000Z'),
    )
    expect(caller.calls[1]?.args.content).toContain('2026-08-31T12:34:56.000Z')
  })

  it('keeps OAuth secrets and tokens in memory and binds tokens to their issuer', async () => {
    const redirects: string[] = []
    const provider = new GitHubOAuthProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUrl: 'http://127.0.0.1:8765/oauth/callback',
      onAuthorization: async url => { redirects.push(url.href) },
    })
    const state = provider.state()
    expect(state).toBe(provider.expectedState)
    expect(provider.clientInformation({ issuer: 'https://github.com' })).toEqual({
      client_id: 'client-id', client_secret: 'client-secret', issuer: 'https://github.com',
    })
    provider.saveTokens({ access_token: 'access', token_type: 'bearer', issuer: 'https://github.com' })
    expect(provider.tokens({ issuer: 'https://github.com' })?.access_token).toBe('access')
    expect(provider.tokens({ issuer: 'https://attacker.example' })).toBeUndefined()
    await provider.redirectToAuthorization(new URL('https://github.com/login/oauth/authorize'))
    expect(redirects).toEqual(['https://github.com/login/oauth/authorize'])
  })
})

function writeConfig(overrides: Partial<GitHubMcpCliConfig>): GitHubMcpCliConfig {
  return {
    help: false,
    command: 'create-file',
    auth: { kind: 'pat', token: 'not-used-by-command-unit-test' },
    url: GITHUB_MCP_URL,
    owner: 'acme',
    repo: 'widget',
    branch: 'mcp-test',
    path: 'mcp/check.md',
    message: 'test: add GitHub MCP human check',
    maxOutputChars: 12_000,
    ...overrides,
  }
}

function scriptedCaller(results: readonly ToolExecutionResult[]): GitHubMcpToolCaller & {
  readonly calls: { name: GitHubMcpToolName; args: JsonObject }[]
} {
  const calls: { name: GitHubMcpToolName; args: JsonObject }[] = []
  const queue = [...results]
  return {
    calls,
    call: vi.fn(async (name: GitHubMcpToolName, args: JsonObject) => {
      calls.push({ name, args })
      const result = queue.shift()
      if (result === undefined) throw new Error('scripted caller exhausted')
      return result
    }),
  }
}

function success(text: string): ToolExecutionResult {
  const value: JsonObject = { content: [{ type: 'text', text }] as JsonValue[] }
  return { isError: false, value, content: [{ type: 'text', text }] }
}

function failure(message: string): ToolExecutionResult {
  return {
    isError: true,
    error: { code: 'TOOL_FAILED', message },
    content: [{ type: 'text', text: message }],
  }
}
