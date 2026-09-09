import { ToolRegistry, defineTool } from '@alvin0/ai-agent-sdk-core/tools'
import { createMcpServer, type McpWebServer } from '@alvin0/ai-agent-sdk-mcp-server'

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'ping', description: 'Return pong.', parameters: { type: 'object' }, execute: () => ({ pong: true }),
}))
const server: McpWebServer = createMcpServer({ id: 'typed-server', tools })
const signal = new AbortController().signal
void server.handle(new Request('https://mcp.example.test'), { signal })
