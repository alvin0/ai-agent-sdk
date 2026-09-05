import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

async function entry(relativePath: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(resolve(root, relativePath)).href) as Record<string, unknown>
}

describe('target package runtime identity', () => {
  it('keeps focused core routes on the canonical core instance', async () => {
    const core = await entry('packages/core/dist/index.js')
    const agent = await entry('packages/core/dist/agent.js')
    const tools = await entry('packages/core/dist/tools.js')
    const observability = await entry('packages/core/dist/observability.js')

    expect(core.defineAgent).toBeTypeOf('function')
    expect(core.createAgentRuntime).toBeTypeOf('function')
    expect(core.defineTool).toBeTypeOf('function')
    expect(agent.defineAgent).toBe(core.defineAgent)
    expect(agent.createAgentRuntime).toBe(core.createAgentRuntime)
    expect(agent.defineTool).toBe(core.defineTool)
    expect(tools.ToolRegistry).toBe(agent.ToolRegistry)
    expect(tools.defineTool).toBe(agent.defineTool)
    expect(observability.createObservability).toBeTypeOf('function')
  })

  it('keeps retained compatibility subpaths on their target package owners', async () => {
    const a2a = await entry('packages/a2a/dist/index.mjs')
    const a2aClient = await entry('packages/a2a/dist/client.mjs')
    const a2aServer = await entry('packages/a2a/dist/server.mjs')
    const mcp = await entry('packages/mcp/dist/index.js')
    const mcpClient = await entry('packages/mcp/dist/client.js')
    const mcpServerView = await entry('packages/mcp/dist/server.js')
    const mcpServer = await entry('packages/mcp-server/dist/index.js')

    expect(a2aClient.A2AAgentLink).toBe(a2a.A2AAgentLink)
    expect(a2aServer.DefinedAgentA2AExecutor).toBe(a2a.DefinedAgentA2AExecutor)
    expect(mcpClient.McpClientConnection).toBe(mcp.McpClientConnection)
    expect(mcpServerView.createSdkMcpServer).toBe(mcpServer.createSdkMcpServer)
  })
})
