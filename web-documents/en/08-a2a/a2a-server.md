# A2A Server

Expose a `DefinedAgent` so other services can call it over A2A Protocol v1.0.

Runtime: **Node 22.12+**. Entrypoint: `@alvin0/ai-agent-sdk-a2a/server`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-a2a
```

The bridge builds on the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)
server API. It gives you a transport-neutral request handler — **not** a
listener — so your framework stays your choice.

## Exports

```ts
export { createAgentCardFromDefinition }
export class DefinedAgentA2AExecutor implements AgentExecutor { … }
export function createDefinedAgentA2AServer(
  options: DefinedAgentA2AServerOptions,
): DefinedAgentA2AServer
export interface A2ADisposeReport { … }
```

```ts
const agentCard = createAgentCardFromDefinition(reviewer, {
  url: 'https://agents.example.com/reviewer/a2a',
  protocolBinding: 'JSONRPC',
  version: '1.0.0',
  tags: ['review', 'release'],
})

const { requestHandler } = createDefinedAgentA2AServer({
  agent: reviewer,
  registry,
  agentCard,
})
```

`requestHandler` is the official transport-neutral `DefaultRequestHandler`. Mount
it with the official Express JSON-RPC/REST handlers, gRPC service, or a custom
transport — keeping HTTP framework code outside this package avoids forcing
Express or gRPC on every SDK consumer.

### Options

| Option | Purpose |
| --- | --- |
| `agent` | The `DefinedAgent` to expose. |
| `registry` | Shared registry, when every request may use the same one. |
| `createSession(context)` | Per-request registries, tools, or policies. Replaces `registry`. |
| `sessionOwner(context)` | Choose the isolation boundary — user, device, workspace, API client. |
| `requireAuthenticated` | Set `true` only when the transport supplies an authenticated `User`. |
| `agentCard` | Security schemes are passed through when configured. |

### Task lifecycle

The bridge implements the official lifecycle: initial `Task`, `WORKING`, artifact
update, then `COMPLETED`, `FAILED`, or `CANCELED`.

A session is retained per `(session owner, A2A contextId)`, so a new task in an
existing owned context sees prior messages **without sharing history across
owners**. The default owner is the authenticated A2A principal when one exists,
otherwise `anonymous`.

Inbound messages are recorded with `source.kind === 'a2a-message'` plus their
protocol `contextId`, `messageId`, and `taskId`.

---

---

## Closing order

Close the runtime/team first, then retain the idempotent `unlink()` and server
dispose (`A2ADisposeReport`) reports separately.

## What stays with the host

Authentication, endpoint policy, persistence, and HTTP framework adaptation are
host-owned. This package supplies bounded state, TTL, cancellation/disposal,
error sanitization, owner scoping, and policy hooks — not a production control
plane.

## Read next

- [Remote Agents](/en/08-a2a/remote-agents) — the consuming side
- [Agent Discovery](/en/08-a2a/agent-discovery) — publishing your Agent Card
- [Security](/en/10-advanced/security) — authentication stays host policy
