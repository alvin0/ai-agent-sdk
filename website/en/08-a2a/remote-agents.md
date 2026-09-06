# Remote Agents

Runtime: **Node 22.12+**. Entrypoints: `.`, `./client`, `./server`.
Composition: `runtime-team.linkAgent`. Lifecycle: `borrowed-caller-owned`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/a2a
```

Node-elevated bridge between AI Agent SDK agents/teams and the official
[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) client/server APIs
implementing A2A Protocol v1.0.

> **Why Node.** The official A2A codec uses `Buffer.from` for raw binary `Part`
> serialization. Text, structured data, URLs, and binary values are supported in
> Node, but the package must not be advertised for Edge/Worker runtimes until
> its committed negative promotion gate passes without Node globals. The `.`
> root plus the `./client` and `./server` subpaths are compatibility aliases over
> the same implementation.

---

## `/client`

```ts
export class A2AAgentLink implements LinkedAgentTransport { … }
export function createA2AAgentLink(options: A2AAgentLinkOptions): Promise<A2AAgentLink>
export function linkA2AAgent(team, options): Promise<{ link: A2AAgentLink; unlink(): Promise<void> }>
```

```ts
import { linkA2AAgent } from '@ai-agent-sdk/a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  streaming: true,
})
```

### Construction — exactly one required

| Input | Use when |
| --- | --- |
| `baseUrl` | You want Agent Card discovery. |
| `agentCard` | You already fetched the card. |
| `client` | You already built an official A2A `Client`. |

### Transport and compatibility

JSON-RPC and HTTP+JSON transports are enabled. v0.3 compatibility is **disabled
by default** and enabled explicitly with `legacyCompat: true`.

`streaming` overrides the Agent Card capability; omit it to follow the card.
Streaming lifecycle events are observable with `onStreamEvent`.

### Endpoint policy — opt in

The client is deployment-policy neutral and accepts standard HTTP/HTTPS and
private endpoints unless the host opts into constraints:

```ts
{
  requireHttps: true,
  allowPrivateNetwork: false,
  allowRedirects: false,
  allowedOrigins: ['https://security-agent.example.com'],
  // or supply your own `fetch` / `validateEndpoint`
}
```

Request, response, HTTP-body, stream event/byte, context-count, TTL, and timeout
budgets are configured independently.

### Context retention

One remote `contextId` is retained per `(team, sender)`, so later `followup_task`
calls resume the same remote conversation. Dispatches to the same remote target
are **FIFO**.

Remote peers support **wake-up delivery only**, because A2A has no standard
operation for silently mutating another agent's private history. `send_message`
therefore targets local sessions; `followup_task` targets either.

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

- [A2A Server](/en/08-a2a/a2a-server) — the publishing side
- [Agent Communication](/en/08-a2a/agent-communication)
- [Security](/en/10-advanced/security) — endpoint policy in context
