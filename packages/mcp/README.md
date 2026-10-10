# @alvin0/ai-agent-sdk-mcp

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp
```

Universal MCP client for Fetch-shaped HTTP runtimes. It connects remote MCP
servers to the SDK as a versioned `ToolSource`.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { connectMcpHttp } from '@alvin0/ai-agent-sdk-mcp'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let connection: Awaited<ReturnType<typeof connectMcpHttp>> | undefined
try {
  connection = await connectMcpHttp({
    serverName: 'tools',
    url: 'https://tools.example.com/mcp',
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })
  const agent = runtime.agent({ model, toolSources: [connection] })
  await agent.generate('Use the connected tools when needed.')
} finally {
  try {
    await runtime.close()
  } finally {
    await connection?.closeWithReport()
  }
}
```

The normal root and `/client` route contain no server, stdio, filesystem,
`node:http`, or process lifecycle integration. Use `@alvin0/ai-agent-sdk-mcp-node` for
the Node stdio client, and a dedicated server package for hosting.

HTTP endpoints are host-selected. HTTPS, public-network-only access, and no
redirects are the defaults; local development must opt out explicitly. Use
`allowedOrigins`, the async `validateEndpoint` hook, a DNS-pinning custom fetch
or network egress policy, response/catalog/result bounds, and operation deadlines
according to the application's trust boundary. OAuth credential persistence and
redirect handling remain caller-owned.

Custom OAuth providers must preserve the authorization-server `issuer` when
storing both tokens and dynamically registered client information. Credentials
saved without an issuer must be discarded and authorized again before reuse.
When using an upstream bundled OAuth provider, configure its `expectedIssuer`
for the trusted authorization server. The SDK uses MCP client/core 2.2.0 or newer
for issuer checks; caller-owned persistence must retain that binding too.
See the [upstream OAuth security advisory](https://github.com/advisories/GHSA-6qxp-vccf-f47h).

Composition: `runtime-agent.toolSources`. Lifecycle: `connected-caller-owned`;
create the runtime first, pass `runtime.logger(...)` while connecting, close the
runtime to quiesce runs, then inspect `connection.closeWithReport()`.
