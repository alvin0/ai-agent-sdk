# MCP — consume and publish

MCP is an **optional boundary**. The provider-neutral SDK does not import it;
applications install only the entries they use.

| Package | Tier | Role |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-mcp` | Universal | HTTP client + `ToolSource`; also `/server` |
| `@alvin0/ai-agent-sdk-mcp-server` | Universal | Inert `Request`/`Response` server host |
| `@alvin0/ai-agent-sdk-mcp-node` | Node | stdio client transport |
| `@alvin0/ai-agent-sdk-mcp-node-server` | Node | stdio / `node:http` hosting |

Client and server are separate, and Node transports separate again, so a web or
worker user never inherits CLI dependencies.

## Consume: remote MCP tools become SDK tools

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { connectMcpHttp } from '@alvin0/ai-agent-sdk-mcp'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let mcp: Awaited<ReturnType<typeof connectMcpHttp>> | undefined

try {
  mcp = await connectMcpHttp({
    serverName: 'billing',
    url: 'https://tools.example.com/mcp',
    headers: { authorization: `Bearer ${token}` },
    toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })

  const agent = runtime.agent({ id: 'support', model, instructions: '…', toolSources: [mcp] })
  await agent.generate('Check invoice INV-42.')
} finally {
  try {
    await runtime.close()          // quiesce runs FIRST
  } finally {
    await mcp?.closeWithReport()   // then close what you connected
  }
}
```

**Close order matters.** Lifecycle is `connected-caller-owned`.

### Connect now, or construct without connecting

```ts
// Negotiates, discovers tools, returns a ready connection:
await connectMcpHttp({ serverName, url })

// Builds one WITHOUT connecting, for hosts that control startup:
const mcp = createMcpHttpClient({
  serverName: 'optional_search',
  url: 'https://search.example.com/mcp',
  reconnect: { maxAttempts: 4 },
  onStateChange: state => updateHealthUi(state),
})
await mcp.connect()   // rejects the initial failure; background reconnect follows policy
```

Legacy SSE: `legacySse: { url: `${base}/sse` }`, or `legacySse: false` to refuse
the fallback.

### Connection semantics

One live generation at a time. It negotiates the modern MCP era with legacy
fallback, publishes tools **only** after a successful handshake **and**
`tools/list`, listens for tool-list changes, swaps only a fully fetched
snapshot, and retains the last-known-good catalog when a refresh fails.

If a server ignores the deadline signal, that client generation is removed from
the live catalog, closed within `closeTimeoutMs`, and reconnected only per
policy. One hung server therefore cannot wedge the agent — the generation is
abandoned, not awaited forever.

### Node stdio

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp @alvin0/ai-agent-sdk-mcp-node
```

```ts
import { connectMcpStdio, createMcpStdioClient } from '@alvin0/ai-agent-sdk-mcp-node'

const local = await connectMcpStdio({
  serverName: 'filesystem',
  command: process.execPath,
  args: ['path/to/server.js'],
  logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
})
```

`createMcpStdioClient()` constructs a supervised client **without spawning the
child**. `connectMcpStdio()` spawns, negotiates, discovers, and on failure
closes with a report and throws `McpConnectionError` carrying it.

### OAuth 2.1

```ts
import { UnauthorizedError } from '@modelcontextprotocol/client'

const mcp = createMcpHttpClient({
  serverName: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  reconnect: false,
  transport: { authProvider: oauthProvider },
})

try {
  await mcp.connect()
} catch (error) {
  if (!(error instanceof UnauthorizedError)) throw error
  const callbackParams = await receiveOAuthCallback()
  await mcp.finishOAuth(callbackParams, { expectedState: stateStoredByHost })
}
```

`finishOAuth()` compares `state` **before** token exchange, passes the complete
callback query through so RFC 9207 `iss` validation stays active, and never
renders attacker-controlled callback error text.

### Resources and prompts

The automatic bridge maps **only MCP tools** into `ToolCatalog`, because that is
what the agent tool loop consumes. Resources and prompts stay reachable without
being forced into the tool abstraction:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))
```

### Closing

```ts
try {
  await runtime.close()
} finally {
  const report = await mcp.closeWithReport()
  if (report.unsettledOperations > 0) console.warn('MCP left work unsettled', report)
}
```

```ts
interface McpCloseReport {
  readonly state: 'closed'
  readonly deadlineReached: boolean
  readonly unsettledOperations: number
  readonly error?: SupportSafeError
}
```

Transport shutdown and runtime shutdown are **independent evidence**. Inspect
both.

## Publish: your tools as an MCP API

`tools` takes a **`ToolCatalog`**, not an array — build one with
`ToolRegistry`:

```ts
// app/api/mcp/route.ts
import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { createSdkMcpHandler } from '@alvin0/ai-agent-sdk-mcp/server'

const catalog = new ToolRegistry()
catalog.register(lookupInvoice)   // returns a disposer; keeps the argument type
// registerAll() is typed ToolDefinition<never>[] — it rejects a typed tool,
// so register() per tool is the path that compiles.

const mcp = createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools: catalog,
  agents: [/* McpAgentTool entries expose a whole agent as one tool */],
})

export async function POST(request: Request): Promise<Response> {
  // Authenticate FIRST — the handler does NOT verify request headers.
  const user = await authenticate(request)
  if (user === null) return new Response('unauthorized', { status: 401 })
  return mcp.fetch(request)
}
```

`SdkMcpServerOptions` also accepts `instructions`, `approvals`, `interceptors`,
and bounds: `maxExports` (1,024), `maxDefinitionBytes` (4 MiB), `maxInputBytes`
(1 MiB), `maxOutputBytes` (4 MiB), `operationTimeoutMs` (10 min),
`teardownTimeoutMs` (30 s), `observerTimeoutMs` (5 s).

The handler accepts already-validated `authInfo` but performs no authentication
of its own. Verify credentials and resource access in the hosting framework
before calling `fetch()`.

Exported tools run the full SDK pipeline: argument parsing, hard outer
deadlines, bounded teardown, approval brokers, interceptors. Tool values become
MCP `structuredContent`; text and inline images stay first-class result content.

An agent can be exposed as a single tool through the same handler.

Two host factories, both from `@alvin0/ai-agent-sdk-mcp-server` (re-exported by
`@alvin0/ai-agent-sdk-mcp/server`):

```ts
createSdkMcpHandler(options: SdkMcpServerOptions, handlerOptions?): SdkMcpHttpHandler
createMcpServer({ id, tools?, agents?, logger?, maxRequestBytes?, maxResponseBytes? }): McpWebServer
// McpWebServer.handle(request, { signal? }): Promise<Response>
```

`createMcpServer()` takes `agents` as a `Record<string, RuntimeAgent>`;
`createSdkMcpHandler()` takes `McpAgentTool[]`. For stdio use `serveMcpStdio()`
from `@alvin0/ai-agent-sdk-mcp-node-server`, or wire either handler into
`node:http`.

By default MCP and A2A server surfaces return generic internal errors. Set
`exposeInternalErrors: true` only on a trusted diagnostic surface.
