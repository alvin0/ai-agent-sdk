# MCP — Overview

MCP (Model Context Protocol) is an **optional boundary**. The provider-neutral
SDK does not import MCP, and applications install only the entries they use.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp
```

## Two directions

| Direction | You get | Package |
| --- | --- | --- |
| **Consume** — remote MCP tools become SDK tools | A versioned `ToolSource` | `@ai-agent-sdk/mcp` |
| **Publish** — SDK tools and agents become an MCP API | A web-standard handler | `@ai-agent-sdk/mcp` `/server`, `@ai-agent-sdk/mcp-server` |

## Four packages

| Package | Runtime | Role |
| --- | --- | --- |
| `@ai-agent-sdk/mcp` | Universal | HTTP client + `ToolSource`; also `/server` |
| `@ai-agent-sdk/mcp-server` | Universal | Inert `Request`/`Response` server host |
| `@ai-agent-sdk/mcp-node` | Node | stdio client transport |
| `@ai-agent-sdk/mcp-node-server` | Node | stdio / `node:http` server hosting |

Client and server are separate, and Node transports are separate again, so a
web or workflow user **never inherits CLI dependencies**. The normal root and
`/client` route contain no server, stdio, filesystem, `node:http`, or process
lifecycle integration.

## The shortest useful example

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { connectMcpHttp } from '@ai-agent-sdk/mcp'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let mcp: Awaited<ReturnType<typeof connectMcpHttp>> | undefined

try {
  mcp = await connectMcpHttp({
    serverName: 'billing',
    url: 'https://tools.example.com/mcp',
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })

  const agent = runtime.agent({ id: 'support', model, instructions: '…', toolSources: [mcp] })
  await agent.generate('Check invoice INV-42.')
} finally {
  try {
    await runtime.close()          // quiesce runs first
  } finally {
    await mcp?.closeWithReport()   // then close what you connected
  }
}
```

**Close order matters.** Lifecycle is `connected-caller-owned`: create the
runtime first, close the runtime to quiesce runs, then close the borrowed
connection and inspect `closeWithReport()`.

## What the bridge maps, and what it does not

The automatic bridge deliberately maps **only MCP tools** to `ToolCatalog`,
because that is the abstraction the agent tool loop consumes.

MCP **resources and prompts** stay available without being forced into the tool
abstraction — reach them through `withClient()`:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))
```

## Safety properties worth knowing up front

| Property | Behaviour |
| --- | --- |
| Tool naming | Prefixed as `mcp__<serverName>__<tool>` to prevent collisions |
| Catalog swaps | Only a **fully fetched** snapshot is published |
| Failed refresh | Retains the last-known-good catalog |
| Snapshots | Synchronous and atomic — one revision binds schema **and** execution |
| Disconnects | Bounded exponential reconnect; `close()` cancels it |
| Generations | One live generation at a time |
| Server auth | The handler does **not** authenticate headers — you do, before `fetch()` |
| Endpoint policy | Host-selected: HTTPS, origins, private-network, byte caps |

## In this chapter

| Page | Answers |
| --- | --- |
| [MCP Client](/en/07-mcp/mcp-client) | The client API surface and every option |
| [Connecting Servers](/en/07-mcp/connecting-servers) | Handshake, transport fallback, OAuth, endpoint policy |
| [Using MCP Tools](/en/07-mcp/using-mcp-tools) | Naming, filtering, catalog revisions, resources and prompts |
| [MCP Server](/en/07-mcp/mcp-server) | Publishing SDK tools and agents as an MCP API |

## Verify without credentials

```bash
npm run human:mcp
```

Performs a real initialize, discovery, and tool call through linked MCP
transports **without provider credentials**, printing lifecycle states,
discovered names, and the structured round-trip result.
