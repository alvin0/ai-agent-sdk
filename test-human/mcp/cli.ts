#!/usr/bin/env node

import { InMemoryTransport } from '@modelcontextprotocol/client'
import { defineTool } from '../../src/agent/tool/definition.ts'
import { dispatchToolCall } from '../../src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../src/agent/tool/registry.ts'
import { ToolCallId } from '../../src/core/primitives/brand.ts'
import { McpClientConnection, type McpClientState } from '../../src/mcp/client.ts'
import { createSdkMcpServer } from '../../src/mcp/server.ts'

const inventory = new Map([
  ['mechanical-keyboard', { stock: 14, unitPrice: 89 }],
  ['usb-c-dock', { stock: 7, unitPrice: 129 }],
])

const api = new ToolRegistry()
api.register(defineTool({
  name: 'quote_inventory',
  description: 'Quote current stock and total price for an inventory item.',
  parameters: {
    type: 'object',
    properties: {
      sku: { type: 'string' },
      quantity: { type: 'integer', minimum: 1 },
    },
    required: ['sku', 'quantity'],
    additionalProperties: false,
  },
  parse: raw => raw as { sku: string; quantity: number },
  execute: ({ sku, quantity }) => {
    const item = inventory.get(sku)
    if (item === undefined) throw new Error(`unknown sku '${sku}'`)
    if (quantity > item.stock) throw new Error(`only ${item.stock} units are available`)
    return { sku, quantity, available: item.stock, totalUsd: quantity * item.unitPrice }
  },
}))

const states: McpClientState[] = []
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createSdkMcpServer({
  name: 'warehouse-api',
  version: '1.0.0',
  instructions: 'Inventory quoting API exported from ai-agent-sdk.',
  tools: api,
})
await server.connect(serverTransport)

const client = new McpClientConnection({
  serverName: 'warehouse',
  reconnect: false,
  onStateChange: state => { states.push(state) },
}, () => clientTransport)

try {
  await client.connect()
  const result = await dispatchToolCall({
    catalog: client.tools,
    call: {
      callId: ToolCallId('human-mcp-quote'),
      toolName: 'mcp__warehouse__quote_inventory',
      rawArguments: JSON.stringify({ sku: 'usb-c-dock', quantity: 3 }),
    },
    position: { turn: 1, step: 1 },
    signal: new AbortController().signal,
  })

  console.log(JSON.stringify({
    scenario: 'SDK tool -> MCP server -> MCP client -> SDK ToolCatalog',
    protocol: 'real MCP initialize + tools/list + tools/call over linked in-memory transport',
    lifecycle: states.map(state => state.status),
    negotiated: client.state.protocol,
    discoveredTools: client.tools.names(),
    call: { sku: 'usb-c-dock', quantity: 3 },
    result,
  }, null, 2))
} finally {
  await client.close()
  await server.close()
}
