import { describe, expect, it, vi } from 'vitest'
import type { JSONRPCMessage, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/server'
import { createMcpServer } from '@alvin0/ai-agent-sdk-mcp-server'
import { serveMcpStdio, toNodeMcpHandler } from '@alvin0/ai-agent-sdk-mcp-node-server'
import { createReportedServerClose } from '../../packages/mcp-node-server/src/server/close.ts'
import { ObservedStdioTransport } from '../../packages/mcp-node-server/src/server/observed-transport.ts'
import { RecordingLogger, integrationOperations } from './fixtures/integration-logger.ts'

class FakeTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
  readonly send = vi.fn(async (_message: JSONRPCMessage, _options?: TransportSendOptions) => undefined)
  readonly start = vi.fn(async () => undefined)
  readonly close = vi.fn(async () => { this.onclose?.() })
}

describe('preferred Node MCP server host', () => {
  it('pairs stdio request evidence with the actual response write', async () => {
    const logger = new RecordingLogger(), inner = new FakeTransport()
    const observed = new ObservedStdioTransport(inner, logger)
    observed.onmessage = () => undefined
    inner.onmessage?.({ jsonrpc: '2.0', id: 7, method: 'tools/list' } as JSONRPCMessage)
    expect(observed.activeRequests).toBe(1)
    await observed.send({ jsonrpc: '2.0', id: 7, result: { tools: [] } } as JSONRPCMessage)
    expect(observed.activeRequests).toBe(0)
    expect(integrationOperations(logger)).toEqual(['request'])
    expect(logger.entries.map(entry => entry.fields.kind)).toEqual([
      'logical-start', 'attempt-start', 'attempt-terminal', 'logical-terminal',
    ])
  })

  it('returns one support-safe close report for success, rejection and unsettled timeout', async () => {
    const successfulTransport = new ObservedStdioTransport(new FakeTransport())
    const successful = createReportedServerClose({ close: async () => undefined }, successfulTransport, 50)
    const first = await successful(), second = await successful()
    expect(second).toBe(first)
    expect(first).toEqual({ state: 'closed', deadlineReached: false, unsettledRequests: 0 })

    const rejectedTransport = new ObservedStdioTransport(new FakeTransport())
    const rejected = createReportedServerClose({ close: async () => { throw new Error('PRIVATE_STDIO/CLOSE~SENTINEL%') } },
      rejectedTransport, 50)
    const rejectedReport = await rejected()
    expect(rejectedReport).toMatchObject({ state: 'closed', deadlineReached: false, unsettledRequests: 0,
      error: { code: 'MCP_NODE_SERVER_CLOSE_FAILED', stage: 'mcp-stdio-server-close' } })
    expect(JSON.stringify(rejectedReport)).not.toContain('PRIVATE_STDIO/CLOSE~SENTINEL%')

    const inner = new FakeTransport(), pendingTransport = new ObservedStdioTransport(inner)
    pendingTransport.onmessage = () => undefined
    inner.onmessage?.({ jsonrpc: '2.0', id: 'pending', method: 'tools/call' } as JSONRPCMessage)
    const timed = createReportedServerClose({ close: async () => undefined }, pendingTransport, 5)
    const timedReport = await timed()
    expect(timedReport).toMatchObject({ state: 'closed', deadlineReached: true, unsettledRequests: 1,
      error: { code: 'MCP_NODE_SERVER_CLOSE_TIMEOUT' } })
  })

  it('keeps preferred stdio and Node HTTP host boundaries explicit', () => {
    expect(() => serveMcpStdio({ handle: async () => new Response() } as never))
      .toThrow('requires a server created by createMcpServer')
    expect(toNodeMcpHandler(createMcpServer({ id: 'node-http' }))).toBeTypeOf('function')
  })
})
