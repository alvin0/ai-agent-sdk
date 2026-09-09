import { createInterface } from 'node:readline'

const serverMeta = {
  'io.modelcontextprotocol/serverInfo': { name: 'packed-node', version: '1.0.0' },
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: value })}\n`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'server/discover') {
    result(message.id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: serverMeta,
    })
    return
  }
  if (message.method === 'tools/list') {
    result(message.id, {
      tools: [{
        name: 'add', description: 'Add two numbers.',
        inputSchema: {
          type: 'object',
          properties: { left: { type: 'number' }, right: { type: 'number' } },
          required: ['left', 'right'], additionalProperties: false,
        },
      }],
      resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: serverMeta,
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'add') {
    const { left, right } = message.params.arguments
    const value = { sum: left + right }
    result(message.id, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value, resultType: 'complete', _meta: serverMeta,
    })
  }
})
