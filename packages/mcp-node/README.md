# @ai-agent-sdk/mcp-node

Runtime: **Node 22.12+**.

```sh
pnpm add @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node
```

Node-only MCP stdio transports and `node:http` adapters. Fetch-shaped MCP
client/server support remains in the Universal `@ai-agent-sdk/mcp` package.

```ts
import { connectMcpStdio, serveSdkMcpStdio, toNodeHandler } from '@ai-agent-sdk/mcp-node'
```
