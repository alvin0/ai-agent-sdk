# @ai-agent-sdk/mcp

Universal MCP bridge for Fetch-shaped HTTP runtimes. It connects remote MCP
servers to the SDK `ToolCatalog` and exposes SDK tools or agents through a
`Request`/`Response` handler.

```ts
import { createMcpHttpClient, createSdkMcpHandler } from '@ai-agent-sdk/mcp'
```

The package works with Web Standards APIs and contains no stdio, filesystem,
`node:http`, or process lifecycle integration. Use `@ai-agent-sdk/mcp-node` for
those Node capabilities once it is installed.

HTTP endpoints are host-selected. Use `allowedOrigins`, `requireHttps`,
`allowPrivateNetwork`, response/catalog/result bounds, and operation deadlines
according to the application's trust boundary. OAuth credential persistence and
redirect handling remain caller-owned.
