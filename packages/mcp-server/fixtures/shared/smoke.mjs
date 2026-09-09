import { ToolRegistry, defineTool } from '@alvin0/ai-agent-sdk-core/tools'
import { createMcpServer } from '@alvin0/ai-agent-sdk-mcp-server'

const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'packed-fixture', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

function tools() {
  const catalog = new ToolRegistry()
  catalog.register(defineTool({
    name: 'add', description: 'Add two numbers.',
    parameters: {
      type: 'object',
      properties: { left: { type: 'number' }, right: { type: 'number' } },
      required: ['left', 'right'], additionalProperties: false,
    },
    parse: value => value,
    execute: ({ left, right }) => ({ sum: left + right }),
  }))
  return catalog
}

async function invoke(server, id, method, params = {}) {
  const requestHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-method': method,
    'mcp-protocol-version': '2026-07-28',
    ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
  }
  const request = new Request('https://mcp.example.test/api', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
  })
  return server.handle(request)
}

export async function runPackedMcpServerFixture() {
  const server = createMcpServer({ id: 'packed-web-server', tools: tools() })
  const discovery = await (await invoke(server, 'discover', 'server/discover')).json()
  const listed = await (await invoke(server, 'list', 'tools/list')).json()
  const called = await (await invoke(server, 'call', 'tools/call', {
    name: 'add', arguments: { left: 19, right: 23 },
  })).json()

  const requestBounded = createMcpServer({ id: 'request-bounded', maxRequestBytes: 32 })
  const oversizedRequest = await requestBounded.handle(new Request('https://mcp.example.test/api', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(33),
  }))

  const responseBounded = createMcpServer({ id: 'response-bounded', maxResponseBytes: 64 })
  let responseBoundedFailure = false
  let responseBoundedError
  try { await (await invoke(responseBounded, 'bounded', 'server/discover')).text() }
  catch (error) { responseBoundedError = String(error); responseBoundedFailure = true }

  const controller = new AbortController()
  controller.abort(new Error('PACKED_ABORT_SENTINEL'))
  let aborted = false
  try {
    await server.handle(new Request('https://mcp.example.test/api', { signal: controller.signal }))
  } catch (error) { aborted = String(error).includes('PACKED_ABORT_SENTINEL') }

  return {
    inert: Object.isFrozen(server) && !('close' in server),
    discovered: discovery.result?.supportedVersions?.includes('2026-07-28') === true,
    listed: listed.result?.tools?.[0]?.name === 'add',
    called: called.result?.structuredContent?.sum === 42,
    requestBounded: oversizedRequest.status === 413,
    responseBounded: responseBoundedFailure,
    responseBoundedError,
    aborted,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
