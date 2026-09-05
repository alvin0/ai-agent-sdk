import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@ai-agent-sdk/core'
import type { RuntimeAgent } from '@ai-agent-sdk/core/agent'
import { defineTool, dispatchToolCall, ToolRegistry } from '@ai-agent-sdk/core/tools'
import { createMcpHttpClient } from '@ai-agent-sdk/mcp/client'
import { createMcpServer } from '@ai-agent-sdk/mcp-server'
import { RecordingLogger, integrationOperations } from './fixtures/integration-logger.ts'

function tools(): ToolRegistry {
  const catalog = new ToolRegistry()
  catalog.register(defineTool({
    name: 'add', description: 'Add two numbers.',
    parameters: { type: 'object', properties: { left: { type: 'number' }, right: { type: 'number' } },
      required: ['left', 'right'], additionalProperties: false },
    parse: value => value as { left: number; right: number },
    execute: ({ left, right }) => ({ sum: left + right }),
  }))
  return catalog
}

describe('preferred Universal MCP server', () => {
  it('is inert to the host and serves a captured tool catalog over Request/Response', async () => {
    const logger = new RecordingLogger()
    const server = createMcpServer({ id: 'web-tools', tools: tools(), logger })
    expect(Object.isFrozen(server)).toBe(true)
    expect('close' in server).toBe(false)
    const connection = createMcpHttpClient({
      serverName: 'web-tools', url: 'https://mcp.example.test/api', reconnect: false,
      transport: { fetch: async (input, init) => server.handle(new Request(input, init)) },
    })
    try {
      await connection.connect()
      const result = await dispatchToolCall({
        catalog: connection.tools,
        call: { callId: ToolCallId('preferred-web'), toolName: 'mcp__web-tools__add',
          rawArguments: '{"left":19,"right":23}' },
        position: { turn: 1, step: 1 }, signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: { structuredContent: { sum: 42 } } })
    } finally { await connection.closeWithReport() }
    expect(integrationOperations(logger)).toEqual(expect.arrayContaining(['request', 'tool-call']))
  })

  it('captures agent generate once and enforces the actual request byte bound', async () => {
    const original = vi.fn(async () => ({ runId: 'run', traceId: 'trace', text: 'captured response',
      usage: {}, report: {} }))
    const mutable = { generate: original } as unknown as RuntimeAgent
    const bounded = createMcpServer({ id: 'bounded', maxRequestBytes: 128 })
    const server = createMcpServer({ id: 'web-agents', agents: { research: mutable } })
    ;(mutable as unknown as { generate: unknown }).generate = vi.fn()
    const oversized = await bounded.handle(new Request('https://mcp.example.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(129),
    }))
    expect(oversized.status).toBe(413)

    const connection = createMcpHttpClient({
      serverName: 'web-agents', url: 'https://mcp.example.test/api', reconnect: false,
      transport: { fetch: async (input, init) => server.handle(new Request(input, init)) },
    })
    try {
      await connection.connect()
      const result = await connection.withClient(client => client.callTool({
        name: 'research', arguments: { input: 'question' },
      }))
      expect(result.structuredContent).toMatchObject({ text: 'captured response', runId: 'run', traceId: 'trace' })
      expect(original).toHaveBeenCalledOnce()
    } finally { await connection.closeWithReport() }
  })
})
