import assert from 'node:assert/strict'
import * as sdk from 'ai-agent-sdk'
import * as anthropic from 'ai-agent-sdk/anthropic'
import * as openai from 'ai-agent-sdk/openai'
import * as codex from 'ai-agent-sdk/codex'
import * as a2aClient from 'ai-agent-sdk/a2a-client'
import * as a2aServer from 'ai-agent-sdk/a2a-server'
import * as filesystem from 'ai-agent-sdk/skill-filesystem'
import * as requestLogger from 'ai-agent-sdk/request-logger'
import * as mcpClient from 'ai-agent-sdk/mcp-client'
import * as mcpServer from 'ai-agent-sdk/mcp-server'
import * as mcpNode from 'ai-agent-sdk/mcp-node'
import * as node from 'ai-agent-sdk/node'
import * as core from '@ai-agent-sdk/core'
import * as providerAnthropic from '@ai-agent-sdk/provider-anthropic'
import * as providerOpenAi from '@ai-agent-sdk/provider-openai'
import * as authCodex from '@ai-agent-sdk/auth-node/codex'
import * as canonicalA2aClient from '@ai-agent-sdk/a2a/client'
import * as canonicalA2aServer from '@ai-agent-sdk/a2a/server'
import * as canonicalMcpClient from '@ai-agent-sdk/mcp/client'
import * as canonicalMcpServer from '@ai-agent-sdk/mcp/server'
import * as canonicalMcpNode from '@ai-agent-sdk/mcp-node'
import * as canonicalFilesystem from '@ai-agent-sdk/skill-filesystem'

assert.equal(sdk.ModelRegistry, core.ModelRegistry)
assert.equal('apiKeyFromEnv' in sdk, false)
assert.equal(anthropic.anthropicAdapter, providerAnthropic.anthropicAdapter)
assert.equal(openai.openAiAdapter, providerOpenAi.openAiAdapter)
assert.equal(codex.codexAdapter, authCodex.codexAdapter)
assert.equal(a2aClient.A2AAgentLink, canonicalA2aClient.A2AAgentLink)
assert.equal(a2aServer.DefinedAgentA2AExecutor, canonicalA2aServer.DefinedAgentA2AExecutor)
assert.equal(filesystem.fileSystemSkills, canonicalFilesystem.fileSystemSkills)
assert.equal(mcpClient.McpClientConnection, canonicalMcpClient.McpClientConnection)
assert.equal(mcpServer.createSdkMcpServer, canonicalMcpServer.createSdkMcpServer)
assert.equal(mcpNode.createMcpStdioClient, canonicalMcpNode.createMcpStdioClient)
assert.equal(node.ModelRegistry, core.ModelRegistry)
assert.equal(typeof requestLogger.createDailyJsonlRequestLogger, 'function')
console.log('sdk-all-legacy-packed:pass')
