import { createMcpHttpClient } from '@ai-agent-sdk/mcp'

const ADD_SCHEMA = Object.freeze({
  type: 'object',
  properties: { left: { type: 'number' }, right: { type: 'number' } },
  required: ['left', 'right'],
  additionalProperties: false,
})

function protocolResponse(id, result) {
  return Response.json({ jsonrpc: '2.0', id, result })
}

function createProtocolFetch(methods, toolCount = 1) {
  return async (input, init) => {
    const request = new Request(input, init)
    const message = await request.json()
    methods.push(message.method)
    if (message.method === 'server/discover') {
      return protocolResponse(message.id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: { listChanged: false } },
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'packed', version: '1.0.0' } },
      })
    }
    if (message.method === 'tools/list') {
      const tools = [{ name: 'add', description: 'Add two numbers.', inputSchema: ADD_SCHEMA }]
      if (toolCount > 1) tools.push({
        name: 'subtract', description: 'Subtract two numbers.', inputSchema: { type: 'object' },
      })
      return protocolResponse(message.id, {
        tools, resultType: 'complete', ttlMs: 0, cacheScope: 'private',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'packed', version: '1.0.0' } },
      })
    }
    if (message.method === 'tools/call' && message.params?.name === 'add') {
      const { left, right } = message.params.arguments
      const value = { sum: left + right }
      return protocolResponse(message.id, {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        resultType: 'complete',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'packed', version: '1.0.0' } },
      })
    }
    return Response.json({
      jsonrpc: '2.0', id: message.id ?? null,
      error: { code: -32601, message: `Unsupported fixture method ${String(message.method)}` },
    })
  }
}

export async function runPackedMcpFixture() {
  const methods = []
  const connection = createMcpHttpClient({
    serverName: 'packed', url: 'https://mcp.example.test/api', reconnect: false,
    legacySse: false, transport: { fetch: createProtocolFetch(methods) },
  })
  let sum
  let mainError
  try {
    await connection.connect()
    const called = await connection.withClient(client => client.callTool({
      name: 'add', arguments: { left: 19, right: 23 },
    }))
    sum = called.structuredContent?.sum
  } catch (error) {
    mainError = String(error)
  } finally {
    await connection.close()
  }

  let aborted = false
  const abortConnection = createMcpHttpClient({
    serverName: 'abort', url: 'https://mcp.example.test/api', reconnect: false, legacySse: false,
    operationTimeoutMs: 10, closeTimeoutMs: 10,
    transport: { fetch: createProtocolFetch([]) },
  })
  try {
    await abortConnection.connect()
    await abortConnection.withClient(async (_client, signal) => await new Promise((resolve, reject) => {
      const onAbort = () => { aborted = signal.aborted; reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
    }))
  } catch { /* the bounded abort is the expected result */ }
  finally { await abortConnection.close() }

  const auth = createMcpHttpClient({
    serverName: 'auth', url: 'https://mcp.example.test/api', reconnect: false, legacySse: false,
    transport: {
      authProvider: { token: async () => 'invalid' },
      fetch: async () => new Response(null, {
        status: 401, headers: { 'www-authenticate': 'Bearer realm="packed"' },
      }),
    },
  })
  let authFailed = false
  let authObserved = false
  let authStatus
  let authReason
  try { await auth.connect() } catch {
    authStatus = auth.state.status
    authReason = auth.state.authorization?.reason
    authFailed = auth.state.status === 'authentication-failed'
    authObserved = auth.state.authorization?.reason === 'invalid-credentials'
  }
  finally { await auth.close() }

  const bounded = createMcpHttpClient({
    serverName: 'bounded', url: 'https://mcp.example.test/api', reconnect: false,
    legacySse: false, maxTools: 1, transport: { fetch: createProtocolFetch([], 2) },
  })
  let boundedFailure = false
  let boundedMessage
  try { await bounded.connect() } catch (error) {
    boundedMessage = String(error)
    boundedFailure = boundedMessage.includes('1-tool limit')
  }
  finally { await bounded.close() }

  return {
    ready: methods.includes('server/discover'),
    listed: methods.includes('tools/list'),
    called: methods.includes('tools/call'),
    methods,
    sum,
    mainError,
    aborted,
    authFailed,
    authObserved,
    authStatus,
    authReason,
    boundedFailure,
    boundedMessage,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
