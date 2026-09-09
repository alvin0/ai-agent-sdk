# Deploying to a Browser

An in-browser agent whose observation events survive a tab crash, a reload, or a
closed laptop — staged in IndexedDB and acknowledged only after your own remote
sink confirms delivery.

## Install

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-openai \
  @ai-agent-sdk/observability-browser
```

## Setup

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'
import {
  indexedDbObservationExporter,
  installBrowserObservabilityLifecycle,
} from '@ai-agent-sdk/observability-browser'

const queue = indexedDbObservationExporter()

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: () => sessionToken.get() })],
  resource: { serviceName: 'studio-web', runtime: 'browser' },
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: queue,
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

// Opt-in: flush on hidden visibility and pagehide.
installBrowserObservabilityLifecycle(runtime)
```

The exporter stages privacy-processed events in IndexedDB during **synchronous
capture** and confirms `local-durable` only after the transaction commits at
flush or checkpoint.

Database defaults: `ai-agent-sdk-observability`, schema version 1, stores
`events`, `batches`, `meta`.

## Recover on startup

```ts
const pending = await queue.recoverEvents()

if (pending.length > 0) {
  const response = await fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pending),
  })

  if (response.ok) {
    // Only now is it safe to drop them.
    await queue.acknowledgeBatch(pending.map(event => event.eventId))
  }
}
```

**Stored events remain unacknowledged until you acknowledge them.** That is the
whole point: an event dropped because the browser called it "sent" is an event
you cannot audit.

`recoverEvents()` exposes crash/reopen recovery **without importing a network
exporter** — you own the transport to your own backend.

## Persist the conversation too

Observation durability is separate from conversation durability. Snapshot the
session yourself:

```ts
const session = agent.createSession({ conversationId })

await session.run(input)

localStorage.setItem(
  `conversation:${session.conversationId}`,
  JSON.stringify(session.snapshot()),
)
```

```ts
const stored = localStorage.getItem(`conversation:${conversationId}`)
const session = stored === null
  ? agent.createSession({ conversationId })
  : agent.resumeSession(JSON.parse(stored))
```

The snapshot is JSON-safe. Skill bodies and resources are never persisted —
resume rediscovers and rehydrates them, failing before the model request if a
source drifted.

## The honesty rule

`installBrowserObservabilityLifecycle()` flushes on hidden visibility and
`pagehide`. It makes **no unload-durability claim**, because no browser API can
guarantee one.

If your audit requirement is stronger than "usually", the acknowledged HTTPS
exporter (`@ai-agent-sdk/observability-fetch`) is the honest answer — it retries
the identical serialized batch with an idempotency key until the server accepts
it.

You can register both: IndexedDB as `required`/`local-durable` for crash
survival, and HTTPS as `best-effort`/`remote-acknowledged` for the live path.

## Constraints

- Credentials must reach the browser somehow. Prefer a short-lived token minted
  by your backend over shipping a provider API key to the client.
- Browser storage is per-origin and clearable by the user.
- `@ai-agent-sdk/observability-browser` is Browser-tier — it requires IndexedDB
  and optional page lifecycle APIs.

## Read next

- [Production Deployment](/en/10-advanced/production-deployment) — the shared checklist
- [Observability](/en/10-advanced/observability)
- [Persistent Memory](/en/05-memory/persistent-memory)
