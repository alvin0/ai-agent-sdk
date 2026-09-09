# MCP Server

Publish your SDK tools — and a whole agent — as an MCP API that any MCP client
can consume.

## Web handler (Next.js, Worker, Deno, Bun)

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp
```

```ts
// app/api/mcp/route.ts
import { defineTool } from '@ai-agent-sdk/core'
import { createSdkMcpHandler } from '@ai-agent-sdk/mcp/server'

const lookupInvoice = defineTool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by id.',
  parameters: {
    type: 'object',
    properties: { invoiceId: { type: 'string' } },
    required: ['invoiceId'],
  },
  parse: raw => raw as { invoiceId: string },
  execute: async ({ invoiceId }, ctx) => billing.getInvoice(invoiceId, ctx.signal),
  isConcurrencySafe: () => true,
  timeoutMs: 15_000,
})

const mcp = createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools: [lookupInvoice],
})

export async function POST(request: Request): Promise<Response> {
  // Authenticate FIRST — the handler does not verify request headers.
  const user = await authenticate(request)
  if (user === null) return new Response('unauthorized', { status: 401 })

  return mcp.fetch(request)
}
```

> **The handler accepts already-validated `authInfo`, but it does not
> authenticate request headers.** Verify credentials and resource access in the
> hosting framework before calling `handler.fetch()`.

Exported tools run through the full SDK pipeline: argument parsing, hard outer
deadlines, bounded teardown, approval brokers, and interceptors. Tool values
become MCP `structuredContent`; text and inline images remain first-class result
content.

## Exposing an agent as one tool

```ts
const mcp = createSdkMcpHandler({
  name: 'support-api',
  version: '1.0.0',
  agents: [{
    name: 'run_support',
    agent: supportAgent,
    createSession: async ({ conversationId }) => {
      const snapshot = conversationId === undefined
        ? undefined
        : await sessionStore.load(conversationId)

      return snapshot === undefined
        ? supportAgent.createSession({ registry, conversationId })
        : supportAgent.resumeSession({ registry, snapshot })
    },
  }],
})
```

The server does **not** hide conversation state in a process-global map. You
receive `conversationId` and decide how to create or resume a session — which
keeps web and serverless persistence and isolation policy explicit and yours.

## Bounds and error exposure

Server tool/agent operations, input/output payloads, concurrent calls, error
observers, and teardown all have independent limits.

```ts
createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools,
  exposeInternalErrors: false,   // default — generic internal errors
})
```

Set `exposeInternalErrors: true` **only** for a trusted diagnostic surface.

## Node stdio server

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp-server @ai-agent-sdk/mcp-node-server
```

```ts
import { createMcpServer } from '@ai-agent-sdk/mcp-server'
import { serveMcpStdio } from '@ai-agent-sdk/mcp-node-server'

const server = createMcpServer({
  name: 'local-tools',
  version: '1.0.0',
  tools,
})

const handle = serveMcpStdio(server, { closeTimeoutMs: 10_000, logger })

process.on('SIGTERM', async () => {
  const report = await handle.close()
  console.error('mcp server closed', report)
})
```

`serveMcpStdio()` returns a **host-owned** handle. Always inspect its bounded
close report — transport shutdown and runtime shutdown are independent evidence.

The older advanced entry `serveSdkMcpStdio(options, serveOptions)` remains
available.

## Node HTTP listener

```ts
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@ai-agent-sdk/mcp-node-server'
import { createServer } from 'node:http'

const handler = toNodeHandler(server)

createServer((req, res) => {
  // Apply BEFORE the handler.
  if (!localhostHostValidation(req) || !localhostOriginValidation(req)) {
    res.writeHead(403).end()
    return
  }
  handler(req, res)
}).listen(8765, '127.0.0.1')
```

These validators protect a local listener from **DNS rebinding** and unwanted
browser origins. Use explicit allowlists (`hostHeaderValidation`,
`originValidation`) for a non-localhost deployment.

## Verify it

```bash
npm run human:mcp
```

Performs a real initialize, discovery, and tool call through linked MCP
transports without provider credentials. It prints lifecycle states, discovered
names, and the structured round-trip result.

## Read next

- [MCP Client](/en/07-mcp/mcp-client) — the consuming side
- [Connecting Servers](/en/07-mcp/connecting-servers)
- [Security](/en/10-advanced/security) — what you must authenticate yourself
