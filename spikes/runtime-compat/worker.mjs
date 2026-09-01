import { createMcpHttpClient } from '../../dist/mcp-client.js'
import { createSdkMcpHandler } from '../../dist/mcp-server.js'

export default {
  async fetch(request) {
    stripNodeGlobals()
    const pathname = new URL(request.url).pathname
    if (pathname === '/runtime') {
      return Response.json({
        buffer: typeof globalThis.Buffer,
        process: typeof globalThis.process,
      })
    }
    if (pathname === '/mcp') return await mcpRoundTrip()
    return Response.json({ routes: ['/runtime', '/mcp'] })
  },
}

function stripNodeGlobals() {
  globalThis.Buffer = undefined
  globalThis.process = undefined
}

async function mcpRoundTrip() {
  const handler = createSdkMcpHandler({ name: 'edge-spike', version: '1.0.0' })
  const connection = createMcpHttpClient({
    serverName: 'edge-spike',
    url: 'https://mcp.example.test/api',
    reconnect: false,
    transport: {
      fetch: async (input, init) => await handler.fetch(new Request(input, init)),
    },
  })
  try {
    await connection.connect()
    return Response.json({ status: connection.state.status, tools: connection.tools.names() })
  } finally {
    await connection.close()
    await handler.close()
  }
}
