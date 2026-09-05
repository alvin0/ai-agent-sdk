# @ai-agent-sdk/mcp-node-server

Runtime: **Node 22.12+**.

Node-only hosting adapters for MCP servers created by `@ai-agent-sdk/mcp-server`.

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp-node-server
```

`serveMcpStdio()` returns a host-owned handle. Always inspect its bounded close
report; transport shutdown and runtime shutdown remain independent evidence.

```ts
import { serveMcpStdio } from '@ai-agent-sdk/mcp-node-server'
```

Composition: `host.mcp-server`. Lifecycle: `host-owned`; call
`handle.close({ signal })` and retain deadline/unsettled-request evidence.
