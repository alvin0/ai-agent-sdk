# Deployment patterns

All three targets share one Universal core and agent loop. What changes is the
credential source, the observability exporter, and how the process ends.

## Edge / Worker — Cloudflare, Deno Deploy, Bun

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-fetch
```

Three Universal packages — no Node built-ins reach the bundle.

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { conversationId, message } = await request.json()

    const runtime = await createAgentRuntime({
      providers: [openAiPlugin({ apiKey: () => env.OPENAI_API_KEY })],
      resource: { serviceName: 'support-worker', environment: 'production' },
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
      instructions: 'Help the customer. Look up orders before answering about them.',
      model: { provider: 'openai', id: 'gpt-5.4' },
      tools: [lookupOrder],
      commentary: 'concise',
      maxTurns: 8,
    })

    // Reopen from KV, or start fresh.
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

    // Persist and close AFTER the response streams, without blocking it.
    ctx.waitUntil((async () => {
      try {
        await handle.result
        await env.CONVERSATIONS.put(conversationId, JSON.stringify(session.snapshot()))
      } finally {
        await runtime.close()
      }
    })())

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  },
}
```

Three things make this work: the credential is a closure over `env`, the session
snapshot is the whole continuity story across isolate lifetimes, and
`ctx.waitUntil` is where `runtime.close()` belongs — never on the request path.

## Browser

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-browser
```

```ts
const queue = indexedDbObservationExporter()

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: () => sessionToken.get() })],
  resource: { serviceName: 'studio-web', environment: 'production' },
  observability: {
    mode: 'reliable',
    exporters: [{ exporter: queue, ownership: 'owned', requirement: 'required', boundary: 'local-durable' }],
  },
})

// `installBrowserObservabilityLifecycle(runtime)` does NOT type-check: it needs
// something with flush(), and AgentRuntime has none. With a runtime-owned bus,
// rely on runtime.close() for the final flush and recover explicitly:
const durable = new IndexedDbObservationExporter()
const pending = await durable.recoverEvents()
for (const batchId of await durable.pendingBatchIds()) await durable.acknowledgeBatch(batchId)
```

Events are staged in IndexedDB and acknowledged only after your own remote sink
confirms delivery, so a tab crash, reload, or closed laptop does not lose them.
No unload-durability claim is made.

Never ship a long-lived provider API key to a browser. Use a short-lived
session token fetched from your backend — that is what the `() => …` closure is
for.

## Node CLI / coding harness

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-auth-node \
  @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-mcp-node \
  @alvin0/ai-agent-sdk-observability-node @alvin0/ai-agent-sdk-skill-filesystem
```

```ts
import { createAgentRuntime, createApprovalBroker, defineTool } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { connectMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node'
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'
import { jsonlObservationExporter } from '@alvin0/ai-agent-sdk-observability-node'
import { createInterface } from 'node:readline/promises'
```

The shape that matters for a CLI:

```ts
const runShellCommand = defineTool({
  name: 'run_command',
  description: 'Run a shell command in the project directory.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  parse: raw => raw as { command: string },
  execute: async ({ command }, ctx) => {
    const { stdout, stderr, code } = await exec(command, { signal: ctx.signal })
    return { code, stdout, stderr }
  },
  isConcurrencySafe: () => false,   // a command can change state another reads
  timeoutMs: 120_000,
})
```

Pair it with `createApprovalBroker()` so a person allows or denies each call,
and pass `skillCwd: process.cwd()` when creating the session so filesystem skill
discovery resolves against the right directory.

Close order when you also own MCP connections:

```ts
try {
  await runtime.close()            // quiesce runs first
} finally {
  await mcp.closeWithReport()      // then the borrowed connection
}
```

## Checklist for any target

- `runtime.close()` in a `finally`, and read `unsettledRuns`.
- Credentials as a closure, never a literal in Universal code.
- Persist `session.snapshot()` if the conversation outlives the process.
- Pick the exporter that matches the durability you can actually honour.
- `resource: { serviceName, serviceVersion?, environment?, attributes? }` so traces are attributable. The `runtime` label (`node`/`edge`/`browser`) is detected and appears on the emitted event, not passed in.
