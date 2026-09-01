import { ToolRegistry, defineTool } from '@ai-agent-sdk/agent'
import { createMcpHttpClient, createSdkMcpHandler } from '@ai-agent-sdk/mcp'

function registry(count = 1) {
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'add',
    description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { left: { type: 'number' }, right: { type: 'number' } },
      required: ['left', 'right'],
      additionalProperties: false,
    },
    parse: value => value,
    execute: ({ left, right }) => ({ sum: left + right }),
  }))
  if (count > 1) tools.register(defineTool({
    name: 'subtract', description: 'Subtract two numbers.', parameters: { type: 'object' },
    execute: () => ({ difference: 0 }),
  }))
  return tools
}

function methodsIn(value) {
  if (Array.isArray(value)) return value.flatMap(methodsIn)
  return typeof value === 'object' && value !== null && typeof value.method === 'string'
    ? [value.method]
    : []
}

export async function runPackedMcpFixture() {
  const methods = []
  const serverErrors = []
  const handler = createSdkMcpHandler(
    { name: 'packed-mcp', version: '1.0.0', tools: registry() },
    { onerror: error => serverErrors.push(error.stack ?? String(error)) },
  )
  const connection = createMcpHttpClient({
    serverName: 'packed', url: 'https://mcp.example.test/api', reconnect: false,
    protocol: 'legacy', legacySse: false,
    transport: { fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST') {
        try { methods.push(...methodsIn(await request.clone().json())) } catch { /* empty notification body */ }
      }
      return await handler.fetch(request)
    } },
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
    await handler.close()
  }

  let aborted = false
  const abortHandler = createSdkMcpHandler({ name: 'abort', version: '1.0.0' })
  const abortConnection = createMcpHttpClient({
    serverName: 'abort', url: 'https://mcp.example.test/api', reconnect: false, legacySse: false,
    operationTimeoutMs: 10, closeTimeoutMs: 10,
    transport: { fetch: async (input, init) => abortHandler.fetch(new Request(input, init)) },
  })
  try {
    await abortConnection.connect()
    await abortConnection.withClient(async (_client, signal) => await new Promise((resolve, reject) => {
      const onAbort = () => { aborted = signal.aborted; reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
    }))
  } catch { /* the bounded abort is the expected result */ }
  finally { await abortConnection.close(); await abortHandler.close() }

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

  const boundedHandler = createSdkMcpHandler({
    name: 'bounded', version: '1.0.0', tools: registry(2),
  })
  const bounded = createMcpHttpClient({
    serverName: 'bounded', url: 'https://mcp.example.test/api', reconnect: false,
    legacySse: false, maxTools: 1,
    transport: { fetch: async (input, init) => boundedHandler.fetch(new Request(input, init)) },
  })
  let boundedFailure = false
  let boundedMessage
  try { await bounded.connect() } catch (error) {
    boundedMessage = String(error)
    boundedFailure = boundedMessage.includes('1-tool limit')
  }
  finally { await bounded.close(); await boundedHandler.close() }

  return {
    ready: methods.includes('initialize'),
    listed: methods.includes('tools/list'),
    called: methods.includes('tools/call'),
    methods,
    sum,
    mainError,
    serverErrors,
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
