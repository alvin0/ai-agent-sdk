import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import {
  ModelAdapter, createAgentRuntime,
  type GenerateOptions, type ModelProviderRegistrar, type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { ToolRegistry, defineTool } from '@alvin0/ai-agent-sdk-core/tools'
import { McpClientConnection } from '@alvin0/ai-agent-sdk-mcp'
import { createSdkMcpServer } from '@alvin0/ai-agent-sdk-mcp-server'

class CatalogAdapter extends ModelAdapter {
  readonly observedTools: string[][] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.observedTools.push(options.tools?.map(tool => tool.name) ?? [])
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'mcp-composition-provider',
    displayName: 'MCP composition provider', routes: ['mcp-composition'],
    defaultModel: { provider: 'mcp-composition', id: 'fixture-model' },
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(['mcp-composition'], adapter)
    },
  }
}

function initialTools(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'first', description: 'First remote tool.', parameters: { type: 'object' }, execute: () => null,
  }))
  return tools
}

describe('official MCP ToolSource composition', () => {
  it('applies a refreshed remote catalog only to the next agent invocation', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'live-source', version: '1.0.0', tools: initialTools() })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'live-source', reconnect: false }, () => clientTransport,
    )
    await connection.connect()
    const adapter = new CatalogAdapter()
    const runtime = await createAgentRuntime({ providers: [provider(adapter)] })
    try {
      const agent = runtime.agent({
        id: 'mcp-source-agent', instructions: 'Observe remote tools.',
        toolSources: [connection], compaction: false,
      })
      const first = await agent.generate('first invocation')

      const generation = (connection as unknown as { current: Client }).current
      generation.listTools = vi.fn(async () => ({ tools: [
        { name: 'first', description: 'First remote tool.', inputSchema: { type: 'object' } },
        { name: 'second', description: 'Second remote tool.', inputSchema: { type: 'object' } },
      ] })) as typeof generation.listTools
      await connection.refreshTools()
      const second = await agent.generate('second invocation')

      expect(adapter.observedTools).toEqual([
        ['mcp__live-source__first'],
        ['mcp__live-source__first', 'mcp__live-source__second'],
      ])
      expect(first.report.toolSourceSnapshots).toEqual([{ sourceId: 'live-source', revision: '1' }])
      expect(second.report.toolSourceSnapshots).toEqual([{ sourceId: 'live-source', revision: '2' }])
      expect(first.report.toolSourceSnapshots).toEqual([{ sourceId: 'live-source', revision: '1' }])
    } finally {
      await runtime.close()
      await connection.closeWithReport()
      await server.close()
    }
  })

  it('keeps a connected source caller-owned across construction failure and active-run quiescence', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createSdkMcpServer({ name: 'borrowed-source', version: '1.0.0', tools: initialTools() })
    await server.connect(serverTransport)
    const connection = new McpClientConnection(
      { serverName: 'borrowed-source', reconnect: false }, () => clientTransport,
    )
    await connection.connect()
    const duplicate = provider(new CatalogAdapter())
    await expect(createAgentRuntime({ providers: [duplicate, duplicate] })).rejects.toMatchObject({
      failureCode: 'CAPABILITY_ID_CONFLICT',
    })
    expect(connection.state.status).toBe('ready')

    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    class BlockingAdapter extends ModelAdapter {
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        entered()
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(options.signal?.reason ?? new Error('run aborted'))
          if (options.signal?.aborted === true) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const runtime = await createAgentRuntime({ providers: [provider(new BlockingAdapter())] })
    const run = runtime.agent({ id: 'borrowed-source-agent', instructions: 'Wait.',
      toolSources: [connection], compaction: false }).stream('hold the run')
    const result = run.result.catch(error => error as unknown)
    await started
    const report = await runtime.close()
    expect(report).toMatchObject({ state: 'closed', activeRunsAtClose: 1, abortedRuns: 1 })
    expect(connection.state.status).toBe('ready')
    await result
    await connection.closeWithReport()
    expect(connection.state.status).toBe('closed')
    await server.close()
  })
})
