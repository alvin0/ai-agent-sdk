#!/usr/bin/env node
import { createInterface } from 'node:readline'

const SERVER_META = Object.freeze({
  'io.modelcontextprotocol/serverInfo': Object.freeze({
    name: 'node-codex-local', version: '1.0.0',
  }),
})

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  const message = JSON.parse(line) as RpcRequest
  if (message.method === 'server/discover') {
    respond(message.id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: { listChanged: false } },
      resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: SERVER_META,
    })
    return
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [{
        name: 'multiply',
        description: 'Multiply two finite numbers through a supervised local MCP process.',
        inputSchema: {
          type: 'object',
          properties: { left: { type: 'number' }, right: { type: 'number' } },
          required: ['left', 'right'], additionalProperties: false,
        },
      }],
      resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: SERVER_META,
    })
    return
  }
  if (message.method === 'tools/call' && message.params?.name === 'multiply') {
    const left = message.params.arguments?.left
    const right = message.params.arguments?.right
    if (typeof left !== 'number' || !Number.isFinite(left)
      || typeof right !== 'number' || !Number.isFinite(right)) {
      respondError(message.id, -32602, 'left and right must be finite numbers')
      return
    }
    const value = { product: left * right, transport: 'mcp-stdio' }
    respond(message.id, {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      resultType: 'complete', _meta: SERVER_META,
    })
  }
})

interface RpcRequest {
  readonly id: string | number | null
  readonly method: string
  readonly params?: {
    readonly name?: string
    readonly arguments?: { readonly left?: unknown; readonly right?: unknown }
  }
}

function respond(id: RpcRequest['id'], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id: RpcRequest['id'], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}
