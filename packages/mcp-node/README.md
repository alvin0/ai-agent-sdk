# @alvin0/ai-agent-sdk-mcp-node

Runtime: **Node 22.12+**.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp @alvin0/ai-agent-sdk-mcp-node
```

Node-only MCP stdio client transport. Universal remote HTTP clients remain in
`@alvin0/ai-agent-sdk-mcp`; server hosting is selected separately through
`@alvin0/ai-agent-sdk-mcp-server` or `@alvin0/ai-agent-sdk-mcp-node-server`.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { connectMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let connection: Awaited<ReturnType<typeof connectMcpStdio>> | undefined
try {
  connection = await connectMcpStdio({
    serverName: 'local-tools',
    command: process.execPath,
    args: ['path/to/server.js'],
    logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
  })
  const agent = runtime.agent({ model, toolSources: [connection] })
  await agent.generate('Use the local tools when needed.')
} finally {
  try {
    await runtime.close()
  } finally {
    await connection?.closeWithReport()
  }
}
```

Composition: `runtime-agent.toolSources`. Lifecycle: `connected-caller-owned`;
create the runtime first, pass `runtime.logger(...)`, close the runtime before
the borrowed connection, and inspect `closeWithReport()`.
