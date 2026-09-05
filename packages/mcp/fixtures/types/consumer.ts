import type { SdkLogger, ToolSource } from '@ai-agent-sdk/core/tools'
import { createMcpHttpClient } from '@ai-agent-sdk/mcp'

const signal = new AbortController().signal
const logger: SdkLogger = {
  child: () => logger,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
}
const connection = createMcpHttpClient({
  serverName: 'packed-types', url: 'https://mcp.example.test', legacySse: false,
  signal,
  fetch: async () => Response.json({}),
})
const source: ToolSource = connection
void source.snapshot({ signal, logger })
void connection.state.catalogRevision
void connection.withClient(async (client, signal) => {
  const result = await client.callTool({ name: 'ping', arguments: {} }, { signal })
  return result.content.length
})
