import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const compatibilityDist = resolve(root, 'packages/sdk/dist')

describe('workspace compatibility runtime identity', () => {
  it('re-exports single core, agent, transport, and protocol package instances', async () => {
    const compatibility = await import(pathToFileURL(resolve(compatibilityDist, 'index.js')).href)
    const a2aClientCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'a2a-client.js')).href)
    const a2aServerCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'a2a-server.js')).href)
    const anthropicCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'anthropic.js')).href)
    const codexCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'codex.js')).href)
    const openAiCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'openai.js')).href)
    const mcpClientCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'mcp-client.js')).href)
    const mcpServerCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'mcp-server.js')).href)
    const mcpNodeCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'mcp-node.js')).href)
    const nodeCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'node.js')).href)
    const skillCompatibility = await import(pathToFileURL(resolve(compatibilityDist, 'skill-filesystem.js')).href)
    const core = await import(pathToFileURL(resolve(root, 'packages/core/dist/index.js')).href)
    const agent = await import(pathToFileURL(resolve(root, 'packages/agent/dist/index.js')).href)
    const providerHttp = await import(pathToFileURL(resolve(root, 'packages/provider-http/dist/index.js')).href)
    const anthropicProtocol = await import(pathToFileURL(resolve(
      root, 'packages/protocol-anthropic-messages/dist/index.js',
    )).href)
    const responsesProtocol = await import(pathToFileURL(resolve(
      root, 'packages/protocol-responses/dist/index.js',
    )).href)
    const mcpClient = await import(pathToFileURL(resolve(root, 'packages/mcp/dist/client.js')).href)
    const mcpServer = await import(pathToFileURL(resolve(root, 'packages/mcp/dist/server.js')).href)
    const a2aClient = await import(pathToFileURL(resolve(root, 'packages/a2a/dist/client.mjs')).href)
    const a2aServer = await import(pathToFileURL(resolve(root, 'packages/a2a/dist/server.mjs')).href)
    const authCodex = await import(pathToFileURL(resolve(root, 'packages/auth-node/dist/codex.mjs')).href)
    const mcpNode = await import(pathToFileURL(resolve(root, 'packages/mcp-node/dist/index.mjs')).href)
    const skillFilesystem = await import(pathToFileURL(
      resolve(root, 'packages/skill-filesystem/dist/index.mjs'),
    ).href)

    expect(compatibility.ModelRegistry).toBe(core.ModelRegistry)
    expect(compatibility.AgentSession).toBe(agent.AgentSession)
    expect(compatibility.AgentTeam).toBe(agent.AgentTeam)
    expect(compatibility.ToolRegistry).toBe(agent.ToolRegistry)
    expect(compatibility.defineAgent).toBe(agent.defineAgent)
    expect(compatibility.HttpModelAdapter).toBe(providerHttp.HttpModelAdapter)
    expect(compatibility.createHttpProvider).toBe(providerHttp.createHttpProvider)
    expect(compatibility.parseSse).toBe(providerHttp.parseSse)
    expect(compatibility.resolveDialect).toBe(providerHttp.resolveDialect)
    expect('apiKeyFromEnv' in compatibility).toBe(false)
    expect(compatibility.anthropicMessagesProtocol).toBe(anthropicProtocol.anthropicMessagesProtocol)
    expect(anthropicCompatibility.anthropicMessagesProtocol)
      .toBe(anthropicProtocol.anthropicMessagesProtocol)
    expect(compatibility.openAiResponsesProtocol).toBe(responsesProtocol.openAiResponsesProtocol)
    expect(openAiCompatibility.openAiResponsesProtocol).toBe(responsesProtocol.openAiResponsesProtocol)
    expect(codexCompatibility.codexAdapter).toBe(authCodex.codexAdapter)
    expect(codexCompatibility.fileCodexAuthStore).toBe(authCodex.fileCodexAuthStore)
    expect(mcpClientCompatibility.McpClientConnection).toBe(mcpClient.McpClientConnection)
    expect(mcpClientCompatibility.createMcpHttpClient).toBe(mcpClient.createMcpHttpClient)
    expect(mcpServerCompatibility.createSdkMcpHandler).toBe(mcpServer.createSdkMcpHandler)
    expect(mcpServerCompatibility.createSdkMcpServer).toBe(mcpServer.createSdkMcpServer)
    expect(a2aClientCompatibility.A2AAgentLink).toBe(a2aClient.A2AAgentLink)
    expect(a2aClientCompatibility.ClientFactory).toBe(a2aClient.ClientFactory)
    expect(a2aServerCompatibility.DefinedAgentA2AExecutor).toBe(a2aServer.DefinedAgentA2AExecutor)
    expect(a2aServerCompatibility.DefaultRequestHandler).toBe(a2aServer.DefaultRequestHandler)
    expect(skillCompatibility.fileSystemSkills).toBe(skillFilesystem.fileSystemSkills)
    expect(mcpNodeCompatibility.createMcpStdioClient).toBe(mcpNode.createMcpStdioClient)
    expect(mcpNodeCompatibility.toNodeHandler).toBe(mcpNode.toNodeHandler)
    expect(nodeCompatibility.ModelRegistry).toBe(core.ModelRegistry)
  })
})
