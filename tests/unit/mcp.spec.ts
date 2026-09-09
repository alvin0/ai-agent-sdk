import {
  Client,
  InMemoryTransport,
  InsufficientScopeError,
  type Transport,
} from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { dispatchToolCall } from '@alvin0/ai-agent-sdk-core/agent'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import {
  McpClientConnection,
  McpConnectionError,
  connectMcpHttp,
  createMcpHttpClient,
  resolveMcpReconnectOptions,
} from '@alvin0/ai-agent-sdk-mcp/client'
import { createSdkMcpHandler, createSdkMcpServer } from '@alvin0/ai-agent-sdk-mcp/server'
import { GitHubOAuthProvider } from '../../test-human/github-mcp/oauth.ts'
import { RecordingLogger, integrationOperations } from './fixtures/integration-logger.ts'

class TextAdapter extends ModelAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'Agent answer over MCP.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Agent answer over MCP.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

function calculatorRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(defineTool({
    name: 'add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { left: { type: 'number' }, right: { type: 'number' } },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    parse: raw => raw as { left: number; right: number },
    execute: ({ left, right }) => ({ sum: left + right }),
  }))
  return registry
}

async function bridgedClient(tools: ToolRegistry) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createSdkMcpServer({ name: 'fixture', version: '1.0.0', tools })
  await server.connect(serverTransport)
  const connection = new McpClientConnection(
    { serverName: 'fixture', reconnect: false },
    () => clientTransport,
  )
  await connection.connect()
  return { connection, server }
}

describe('MCP integration', () => {
  it('is a versioned live ToolSource with revisioned invocation snapshots', async () => {
    const tools = calculatorRegistry()
    const { connection, server } = await bridgedClient(tools)
    try {
      expect(connection).toMatchObject({ kind: 'tool-source', apiVersion: 1, id: 'fixture' })
      expect(connection.state.catalogRevision).toBe(1)
      const first = connection.snapshot({
        signal: new AbortController().signal,
        logger: new RecordingLogger(),
      })
      expect(first.revision).toBe('1')
      expect(first.tools.map(tool => tool.name)).toEqual(['mcp__fixture__add'])
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.tools)).toBe(true)

      tools.register(defineTool({
        name: 'subtract', description: 'Subtract two numbers.', parameters: { type: 'object' },
        execute: () => ({ difference: 1 }),
      }))
      await connection.refreshTools()
      expect(connection.state.catalogRevision).toBe(2)
      expect(connection.snapshot({ signal: new AbortController().signal,
        logger: new RecordingLogger() }).tools.map(tool => tool.name))
        .toEqual(['mcp__fixture__add'])

      const aborted = new AbortController()
      aborted.abort(new Error('stop'))
      expect(() => connection.snapshot({ signal: aborted.signal, logger: new RecordingLogger() })).toThrow('stop')
    } finally {
      await connection.close()
      await server.close()
    }
    expect(connection.state.catalogRevision).toBe(3)
  })

  it('keeps the last good ToolSource snapshot when refresh validation fails', async () => {
    const tools = calculatorRegistry()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'refresh-bound', version: '1.0.0', tools })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'refresh-bound', reconnect: false, maxTools: 1 },
      () => clientTransport,
    )
    try {
      await connection.connect()
      const before = connection.snapshot({ signal: new AbortController().signal,
        logger: new RecordingLogger() })
      const generation = (connection as unknown as { current: Client }).current
      generation.listTools = vi.fn(async () => ({ tools: [
        { name: 'add', inputSchema: { type: 'object' } },
        { name: 'extra', inputSchema: { type: 'object' } },
      ] })) as typeof generation.listTools
      await expect(connection.refreshTools()).rejects.toThrow(/1-tool limit/)
      const after = connection.snapshot({ signal: new AbortController().signal,
        logger: new RecordingLogger() })
      expect(after.revision).toBe(before.revision)
      expect(after.tools.map(tool => tool.name)).toEqual(['mcp__refresh-bound__add'])
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('returns support-safe state projection and honors an abortable close boundary', async () => {
    const failedTransport: Transport = {
      start: async () => { throw new Error('PRIVATE_CONNECT/STATE~SENTINEL%') },
      send: async () => undefined,
      close: async () => undefined,
    }
    const failed = new McpClientConnection(
      { serverName: 'failed-state', reconnect: false },
      () => failedTransport,
    )
    await expect(failed.connect()).rejects.toThrow('PRIVATE_CONNECT/STATE~SENTINEL%')
    expect(failed.state.supportError).toMatchObject({ stage: 'mcp-client' })
    expect(JSON.stringify(failed.state.supportError)).not.toContain('PRIVATE_CONNECT/STATE~SENTINEL%')
    await failed.close()

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'abort-close', version: '1.0.0' })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'abort-close', reconnect: false, closeTimeoutMs: 5_000 },
      () => clientTransport,
    )
    await connection.connect()
    clientTransport.close = vi.fn(async () => await new Promise<never>(() => {}))
    const controller = new AbortController()
    controller.abort(new Error('caller stopped waiting'))
    const report = await connection.closeWithReport({ signal: controller.signal })
    expect(report).toMatchObject({
      state: 'closed', deadlineReached: false, unsettledOperations: 1,
      error: { code: 'MCP_CLOSE_ABORTED', stage: 'mcp-close' },
    })
    void server
  })

  it('returns one idempotent support-safe close report and retains timeout evidence', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'reported-close', version: '1.0.0' })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'reported-close', reconnect: false, closeTimeoutMs: 5 },
      () => clientTransport,
    )
    await connection.connect()
    clientTransport.close = vi.fn(async () => await new Promise<never>(() => {}))
    const first = await connection.closeWithReport()
    const second = await connection.closeWithReport()
    expect(second).toBe(first)
    expect(first).toMatchObject({ state: 'closed', deadlineReached: true, unsettledOperations: 1,
      error: { code: 'MCP_CLOSE_TIMEOUT', stage: 'mcp-close' } })
    expect(JSON.stringify(first)).not.toContain('reported-close')
    void server
  })

  it('reports rejected cleanup without misclassifying it as a deadline or successful log', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'failed-close', version: '1.0.0' })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'failed-close', reconnect: false, closeTimeoutMs: 50 },
      () => clientTransport,
    )
    await connection.connect()
    clientTransport.close = vi.fn(async () => { throw new Error('PRIVATE_MCP/CLOSE~FAILURE%') })
    const report = await connection.closeWithReport()
    expect(report).toMatchObject({ state: 'closed', deadlineReached: false, unsettledOperations: 0,
      error: { code: 'MCP_CLOSE_FAILED', stage: 'mcp-close' } })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_MCP/CLOSE~FAILURE%')
    await expect(connection.close()).resolves.toBeUndefined()
    expect(await connection.closeWithReport()).toBe(report)
    void server
  })

  it('keeps startup failure primary when transactional rollback completes', async () => {
    const privateFailure = 'PRIVATE_MCP_CONNECT/credential'
    let thrown: unknown
    try {
      await connectMcpHttp({
        serverName: 'transactional', url: 'https://mcp.example.test', reconnect: false,
        legacySse: false, transport: { fetch: async () => { throw new Error(privateFailure) } },
      })
    } catch (error: unknown) { thrown = error }
    expect(thrown).toBeInstanceOf(McpConnectionError)
    expect(thrown).toMatchObject({ code: 'MCP_CONNECT_FAILED', stage: 'unknown',
      cleanup: { state: 'closed', deadlineReached: false, unsettledOperations: 0 } })
    expect(JSON.stringify(thrown)).not.toContain(privateFailure)
    expect((thrown as Error).cause).toBeInstanceOf(Error)
  })

  it('contains lifecycle observers and enforces catalog cardinality', async () => {
    const tools = calculatorRegistry()
    tools.register(defineTool({
      name: 'subtract', description: 'Subtract.', parameters: { type: 'object' },
      execute: () => 0,
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'bounded', version: '1.0.0', tools })
    await server.connect(serverTransport)
    const connection = new McpClientConnection({
      serverName: 'bounded', reconnect: false, maxTools: 1,
      onStateChange: () => { throw new Error('observer bug') },
    }, () => clientTransport)
    try {
      await expect(connection.connect()).rejects.toThrow(/1-tool limit/)
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('rejects oversized remote tool results before bridging them into history', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'bounded-result', version: '1.0.0', tools: calculatorRegistry() })
    await server.connect(serverTransport)
    const connection = new McpClientConnection({
      serverName: 'bounded-result', reconnect: false, maxToolResultBytes: 8,
    }, () => clientTransport)
    try {
      await connection.connect()
      const result = await dispatchToolCall({
        catalog: connection.tools,
        call: {
          callId: ToolCallId('bounded-result'), toolName: 'mcp__bounded-result__add',
          rawArguments: '{"left":1,"right":2}',
        },
        position: { turn: 1, step: 1 }, signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: true, error: { code: 'TOOL_FAILED' } })
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('8-byte limit') })
      expect(result.meta).toEqual({
        kind: 'mcp', serverName: 'bounded-result', remoteToolName: 'add',
      })
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('exports an SDK tool and imports it back through a namespaced live catalog', async () => {
    const { connection, server } = await bridgedClient(calculatorRegistry())
    try {
      expect(connection.state.status).toBe('ready')
      expect(connection.state.protocol).toMatchObject({
        era: 'legacy', transport: 'custom', fallback: false,
      })
      expect(connection.tools.names()).toEqual(['mcp__fixture__add'])
      const result = await dispatchToolCall({
        catalog: connection.tools,
        call: {
          callId: ToolCallId('roundtrip-1'),
          toolName: 'mcp__fixture__add',
          rawArguments: JSON.stringify({ left: 20, right: 22 }),
        },
        position: { turn: 1, step: 1 },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      if (!result.isError) {
        expect(result.value).toMatchObject({ structuredContent: { sum: 42 } })
        expect(result.meta).toEqual({ kind: 'mcp', serverName: 'fixture', remoteToolName: 'add' })
      }
      expect(result.content).toContainEqual({ type: 'text', text: expect.stringContaining('"sum": 42') })
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('preserves MCP tool errors as normal SDK tool failures', async () => {
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'explode', description: 'Always fail.', parameters: { type: 'object' },
      execute: () => { throw new Error('fixture exploded') },
    }))
    const { connection, server } = await bridgedClient(tools)
    try {
      const result = await dispatchToolCall({
        catalog: connection.tools,
        call: { callId: ToolCallId('roundtrip-2'), toolName: 'mcp__fixture__explode', rawArguments: '{}' },
        position: { turn: 1, step: 1 }, signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: true, error: { code: 'TOOL_FAILED' } })
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('fixture exploded') })
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('serves the same bridge through a web-standard HTTP API', async () => {
    const lifecycleLogger = new RecordingLogger()
    const activeLogger = new RecordingLogger()
    const serverLogger = new RecordingLogger()
    const handler = createSdkMcpHandler({
      name: 'http-fixture', version: '1.0.0', tools: calculatorRegistry(), logger: serverLogger,
    })
    const connection = createMcpHttpClient({
      serverName: 'http',
      url: 'https://mcp.example.test/api',
      reconnect: false,
      logger: lifecycleLogger,
      transport: {
        fetch: async (input, init) => handler.fetch(new Request(input, init)),
      },
    })
    try {
      await connection.connect()
      const result = await connection.withClient(client => client.callTool({
        name: 'add', arguments: { left: 2, right: 5 },
      }))
      expect(result.structuredContent).toEqual({ sum: 7 })
      const bridged = await dispatchToolCall({
        catalog: connection.tools,
        call: { callId: ToolCallId('logged-tool'), toolName: 'mcp__http__add',
          rawArguments: '{"left":3,"right":4}' },
        position: { turn: 1, step: 1 }, signal: new AbortController().signal,
        logger: activeLogger,
      })
      expect(bridged).toMatchObject({ isError: false })
    } finally {
      await connection.closeWithReport()
      await handler.close()
    }
    expect(integrationOperations(lifecycleLogger)).toEqual(expect.arrayContaining([
      'connect', 'catalog-refresh', 'close',
    ]))
    expect(integrationOperations(lifecycleLogger)).not.toContain('tool-call')
    expect(integrationOperations(activeLogger)).toEqual(['tool-call'])
    expect(integrationOperations(serverLogger)).toEqual(expect.arrayContaining(['request', 'tool-call']))
    const requestScopes = serverLogger.entries
      .filter(entry => entry.fields.kind === 'logical-start' && entry.fields.integrationOperation === 'request')
      .map(entry => entry.fields.integrationScope)
    expect(requestScopes).toEqual(requestScopes.map(() => 'mcp-server-request'))
  })

  it('aborts and retires a generation when a raw MCP operation ignores its deadline', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'raw-deadline', version: '1.0.0', tools: calculatorRegistry() })
    await server.connect(serverTransport)
    const connection = new McpClientConnection({
      serverName: 'raw-deadline', reconnect: false, operationTimeoutMs: 10, closeTimeoutMs: 10,
    }, () => clientTransport)
    try {
      await connection.connect()
      let observedSignal: AbortSignal | undefined
      const started = Date.now()
      await expect(connection.withClient(async (_client, signal) => {
        observedSignal = signal
        return await new Promise<never>(() => {})
      })).rejects.toThrow(/exceeded 10ms/)
      expect(observedSignal?.aborted).toBe(true)
      expect(connection.state.status).toBe('failed')
      expect(connection.tools.names()).toEqual([])
      expect(Date.now() - started).toBeLessThan(250)
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('enforces HTTP endpoint policy and raw response bounds before protocol parsing', async () => {
    expect(() => createMcpHttpClient({
      serverName: 'private-http',
      url: 'http://127.0.0.1/mcp',
      allowPrivateNetwork: false,
    })).toThrow(/private or local/)
    expect(() => createMcpHttpClient({
      serverName: 'wrong-origin',
      url: 'https://mcp.example.test/api',
      allowedOrigins: ['https://approved.example.test'],
    })).toThrow(/not allowed/)

    const connection = createMcpHttpClient({
      serverName: 'bounded-http',
      url: 'https://mcp.example.test/api',
      reconnect: false,
      legacySse: false,
      maxTransportBytes: 8,
      transport: {
        fetch: async () => new Response('oversized response', {
          headers: { 'content-length': '18', 'content-type': 'application/json' },
        }),
      },
    })
    try {
      await expect(connection.connect()).rejects.toThrow(/8-byte limit/)
    } finally {
      await connection.close()
    }
  })

  it('bounds a custom MCP fetch that ignores abort', async () => {
    const connection = createMcpHttpClient({
      serverName: 'stuck-http',
      url: 'https://mcp.example.test/api',
      reconnect: false,
      legacySse: false,
      operationTimeoutMs: 10,
      closeTimeoutMs: 10,
      transport: { fetch: async () => await new Promise<Response>(() => {}) },
    })
    const started = Date.now()
    try {
      await expect(connection.connect()).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(250)
    } finally {
      await connection.close()
    }
  })

  it('pauses an HTTP generation for OAuth, validates state, and reconnects on a fresh transport', async () => {
    const handler = createSdkMcpHandler({
      name: 'oauth-fixture', version: '1.0.0', tools: calculatorRegistry(),
    })
    let authorizationUrl: URL | undefined
    const provider = new GitHubOAuthProvider({
      clientId: 'fixture-client',
      clientSecret: 'fixture-secret',
      redirectUrl: 'http://127.0.0.1:8765/oauth/callback',
      onAuthorization: async url => { authorizationUrl = url },
    })
    const fetchMock = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://mcp.example.test/.well-known/oauth-protected-resource') {
        return Response.json({
          resource: 'https://mcp.example.test/api',
          authorization_servers: ['https://auth.example.test'],
        })
      }
      if (request.url.startsWith('https://auth.example.test/.well-known/')) {
        return Response.json({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        })
      }
      if (request.url === 'https://auth.example.test/token') {
        return Response.json({ access_token: 'oauth-access', token_type: 'Bearer' })
      }
      if (request.headers.get('authorization') !== 'Bearer oauth-access') {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
          },
        })
      }
      return await handler.fetch(request)
    }
    const connection = createMcpHttpClient({
      serverName: 'oauth',
      url: 'https://mcp.example.test/api',
      reconnect: false,
      transport: { authProvider: provider, fetch: fetchMock },
    })
    try {
      await expect(connection.connect()).rejects.toThrow()
      expect(connection.state).toMatchObject({
        status: 'oauth-authorization-required',
        authorization: { kind: 'oauth', reason: 'authorization-code-required' },
      })
      expect(authorizationUrl?.origin).toBe('https://auth.example.test')
      const state = provider.expectedState
      expect(state).toBeTypeOf('string')
      await expect(connection.finishOAuth(
        new URLSearchParams({ code: 'fixture-code', state: 'wrong' }),
        { expectedState: state as string },
      )).rejects.toThrow(/mismatched state/)
      await connection.finishOAuth(
        new URLSearchParams({ code: 'fixture-code', state: state as string }),
        { expectedState: state as string },
      )
      expect(connection.state.status).toBe('ready')
      expect(connection.tools.names()).toEqual(['mcp__oauth__add'])
    } finally {
      await connection.close()
      await handler.close()
    }
  })

  it('reports invalid bearer credentials without attempting the legacy transport', async () => {
    let requests = 0
    const connection = createMcpHttpClient({
      serverName: 'private',
      url: 'https://mcp.example.test/api',
      reconnect: false,
      legacySse: false,
      transport: {
        authProvider: { token: async () => 'invalid-token' },
        fetch: async () => {
          requests += 1
          return new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="fixture"' },
          })
        },
      },
    })
    try {
      await expect(connection.connect()).rejects.toThrow()
      expect(requests).toBe(1)
      expect(connection.state).toMatchObject({
        status: 'authentication-failed',
        authorization: { kind: 'bearer', reason: 'invalid-credentials' },
      })
    } finally {
      await connection.close()
    }
  })

  it('surfaces an insufficient-scope challenge from a connected tool call', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'scope', version: '1.0.0', tools: calculatorRegistry() })
    await server.connect(serverTransport)
    const originalSend = clientTransport.send.bind(clientTransport)
    clientTransport.send = async message => {
      if ('method' in message && message.method === 'tools/call') {
        throw new InsufficientScopeError({ requiredScope: 'repo:write' })
      }
      await originalSend(message)
    }
    const connection = new McpClientConnection(
      { serverName: 'scope', reconnect: false },
      () => clientTransport,
      { authenticationKind: 'bearer' },
    )
    try {
      await connection.connect()
      const result = await dispatchToolCall({
        catalog: connection.tools,
        call: {
          callId: ToolCallId('scope-1'),
          toolName: 'mcp__scope__add',
          rawArguments: JSON.stringify({ left: 1, right: 2 }),
        },
        position: { turn: 1, step: 1 },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      expect(connection.state).toMatchObject({
        status: 'scope-authorization-required',
        authorization: {
          kind: 'bearer', reason: 'insufficient-scope', requiredScope: 'repo:write',
        },
      })
      expect(connection.state.protocol).toMatchObject({ era: 'legacy', fallback: false })
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('negotiates a legacy protocol without changing transport', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'legacy', version: '1.0.0', tools: calculatorRegistry() })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'legacy', protocol: 'legacy', reconnect: false },
      () => clientTransport,
    )
    try {
      await connection.connect()
      expect(connection.state.protocol).toMatchObject({
        era: 'legacy', transport: 'custom', fallback: false,
      })
      expect(connection.tools.names()).toEqual(['mcp__legacy__add'])
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('uses a fresh client generation when the primary transport needs a legacy fallback', async () => {
    const [fallbackTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'fallback', version: '1.0.0', tools: calculatorRegistry() })
    await server.connect(serverTransport)
    const primary: Transport = {
      start: async () => { throw new Error('Streamable HTTP is unavailable') },
      send: async () => undefined,
      close: async () => undefined,
    }
    const connection = new McpClientConnection(
      { serverName: 'fallback', reconnect: false },
      () => primary,
      { fallbackTransportFactory: () => fallbackTransport },
    )
    try {
      await connection.connect()
      expect(connection.state.protocol).toMatchObject({
        era: 'legacy', transport: 'custom', fallback: true,
      })
      expect(connection.tools.names()).toEqual(['mcp__fallback__add'])
    } finally {
      await connection.close()
      await server.close()
    }
  })

  it('exposes a defined agent while leaving session persistence to the host', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], new TextAdapter())
    const agent = defineAgent({
      id: 'support', provider: 'test', model: 'scripted', instructions: 'Answer clearly.',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({
      name: 'agents', version: '1.0.0',
      agents: [{
        name: 'run_support', agent,
        createSession: ({ conversationId }) => agent.createSession({
          registry,
          ...(conversationId === undefined ? {} : { conversationId }),
        }),
      }],
    })
    await server.connect(serverTransport)
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    await client.connect(clientTransport)
    try {
      const result = await client.callTool({
        name: 'run_support',
        arguments: { input: 'Help me.', conversationId: 'web-conversation-7' },
      })
      expect(result.isError).not.toBe(true)
      expect(result.content).toContainEqual({ type: 'text', text: 'Agent answer over MCP.' })
      expect(result.structuredContent).toMatchObject({
        text: 'Agent answer over MCP.', conversationId: 'web-conversation-7',
        outcome: { mode: 'basic', completed: true },
      })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('bounds an uncooperative agent factory and contains a stuck error observer', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], new TextAdapter())
    const agent = defineAgent({
      id: 'stuck-agent', provider: 'test', model: 'scripted', instructions: 'Never reached.',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({
      name: 'bounded-agent', version: '1.0.0',
      operationTimeoutMs: 10,
      teardownTimeoutMs: 10,
      observerTimeoutMs: 10,
      onError: async () => await new Promise<void>(() => {}),
      agents: [{
        name: 'run_stuck', agent,
        createSession: async () => await new Promise<never>(() => {}),
      }],
    })
    await server.connect(serverTransport)
    const client = new Client(
      { name: 'bounded-client', version: '1.0.0' },
      { capabilities: {}, versionNegotiation: { mode: 'auto' } },
    )
    await client.connect(clientTransport)
    const started = Date.now()
    try {
      const result = await client.callTool({ name: 'run_stuck', arguments: { input: 'start' } })
      expect(result.isError).toBe(true)
      expect(result.content).toContainEqual({ type: 'text', text: 'Error: agent operation failed' })
      expect(Date.now() - started).toBeLessThan(250)
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('validates bounded reconnect policy', () => {
    expect(resolveMcpReconnectOptions(undefined)).toEqual({
      enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10,
    })
    expect(resolveMcpReconnectOptions(false).enabled).toBe(false)
    expect(() => resolveMcpReconnectOptions({ initialDelayMs: 100, maxDelayMs: 10 }))
      .toThrow(/less than or equal/)
    expect(() => resolveMcpReconnectOptions({ maxAttempts: 0 })).toThrow(/positive integer/)
  })

  it('replaces a closed generation and re-publishes its tools', async () => {
    const first = InMemoryTransport.createLinkedPair()
    const second = InMemoryTransport.createLinkedPair()
    const firstServer = createSdkMcpServer({ name: 'first', version: '1.0.0', tools: calculatorRegistry() })
    const secondServer = createSdkMcpServer({ name: 'second', version: '1.0.0', tools: calculatorRegistry() })
    await firstServer.connect(first[1])
    await secondServer.connect(second[1])
    const states: string[] = []
    let generation = 0
    const connection = new McpClientConnection({
      serverName: 'recovering',
      reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 },
      onStateChange: state => { states.push(state.status) },
    }, () => generation++ === 0 ? first[0] : second[0])
    try {
      await connection.connect()
      await first[0].close()
      await vi.waitFor(() => { expect(connection.state.status).toBe('ready') })
      expect(generation).toBe(2)
      expect(connection.tools.names()).toEqual(['mcp__recovering__add'])
      expect(states).toContain('reconnecting')
    } finally {
      await connection.close()
      await firstServer.close()
      await secondServer.close()
    }
  })
})
