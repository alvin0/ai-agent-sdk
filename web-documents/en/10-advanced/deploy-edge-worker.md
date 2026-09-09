# Deploying to an Edge Worker

Streaming chat in a Fetch-shaped runtime — Cloudflare Workers, Deno Deploy, Bun,
or any host with `Request`/`Response` and `waitUntil`.

## Install

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-fetch
```

Three packages. All Universal — no Node built-ins reach the bundle.

## Worker

```ts
import { createAgentRuntime, defineTool } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import {
  fetchObservationExporter,
  flushObservabilityWithWaitUntil,
} from '@alvin0/ai-agent-sdk-observability-fetch'

interface Env {
  OPENAI_API_KEY: string
  TELEMETRY_TOKEN: string
  CONVERSATIONS: KVNamespace
}

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by id.',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  parse: raw => raw as { orderId: string },
  execute: async ({ orderId }, ctx) => {
    const response = await fetch(`https://api.example.com/orders/${orderId}`, {
      signal: ctx.signal,
    })
    if (!response.ok) throw new Error(`order lookup failed: ${response.status}`)
    return await response.json()
  },
  isConcurrencySafe: () => true,
  timeoutMs: 10_000,
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { conversationId, message } = await request.json<{
      conversationId: string
      message: string
    }>()

    const runtime = await createAgentRuntime({
      providers: [openAiPlugin({ apiKey: () => env.OPENAI_API_KEY })],
      resource: { serviceName: 'support-worker', runtime: 'edge' },
      observability: {
        mode: 'operational',
        exporters: [{
          exporter: fetchObservationExporter({
            endpoint: 'https://telemetry.example.com/v1/observations',
            headers: { authorization: `Bearer ${env.TELEMETRY_TOKEN}` },
          }),
          ownership: 'owned',
          requirement: 'best-effort',
          boundary: 'remote-acknowledged',
        }],
      },
    })

    const agent = runtime.agent({
      id: 'support',
      name: 'Support',
      instructions: 'Help the customer. Look up orders before answering about them.',
      model: { provider: 'openai', id: 'gpt-5.4' },
      tools: [lookupOrder],
      commentary: 'concise',
      maxTurns: 8,
    })

    // Reopen the conversation from KV, or start a new one.
    const stored = await env.CONVERSATIONS.get(conversationId, 'json')
    const session = stored === null
      ? agent.createSession({ conversationId })
      : agent.resumeSession(stored as never)

    const handle = session.stream(message)

    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        try {
          for await (const event of handle) {
            controller.enqueue(encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ))
          }
        } finally {
          controller.close()
        }
      },
      cancel() {
        handle.abort('client disconnected')
      },
    })

    // Persist and flush after the response streams, without blocking it.
    ctx.waitUntil((async () => {
      try {
        await handle.result
        await env.CONVERSATIONS.put(conversationId, JSON.stringify(session.snapshot()))
      } finally {
        await runtime.close()
      }
    })())

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })
  },
}
```

## What the pieces do

| Piece | Why |
| --- | --- |
| `apiKey: () => env.OPENAI_API_KEY` | Credentials are injected — the provider never reads an environment itself. |
| `boundary: 'remote-acknowledged'` | The exporter honestly states the durability it achieves. |
| `requirement: 'best-effort'` | A telemetry failure must not fail a customer request. |
| `handle.abort(...)` in `cancel()` | Client disconnect cancels the run instead of leaking it. |
| `ctx.waitUntil(...)` | Persistence and close happen after the response, without holding it. |
| `session.snapshot()` / `resumeSession()` | Conversation state lives in KV, not in worker memory. |

## Flushing telemetry explicitly

If you close the runtime before the response finishes, hand the exporter flush to
`waitUntil` instead:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

The package never assumes a platform global — you pass `waitUntil` in.

## Constraints to keep in mind

- **Nothing Node-only may enter the bundle.** `@alvin0/ai-agent-sdk-auth-node`,
  `mcp-node`, `skill-filesystem`, `observability-node`, and `a2a` are Node-tier.
- **An Edge host cannot rely on process exit.** Every flush must be explicit.
- **A worker has no durable local disk.** Conversation snapshots belong in KV, D1,
  Durable Objects, or your own store.

## Read next

- [Production Deployment](/en/10-advanced/production-deployment) — the shared checklist
- [Persistent Memory](/en/05-memory/persistent-memory)
- [Observability](/en/10-advanced/observability)
