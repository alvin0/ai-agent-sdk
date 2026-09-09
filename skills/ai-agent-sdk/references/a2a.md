# A2A and agent teams

Two layers behind **one** roster:

| Layer | What it is | Package |
| --- | --- | --- |
| `AgentTeam` | Collaboration between long-lived **in-process** sessions | `@alvin0/ai-agent-sdk-core/agent` |
| A2A Protocol v1.0 | Agent Card discovery + **remote** JSON-RPC / HTTP+JSON | `@alvin0/ai-agent-sdk-a2a` |

Protocol interoperability alone does not implement a local scheduler, and an
in-process mailbox cannot reach another service. `AgentTeam` routes both kinds
through the same roster, so a model calling `followup_task` does not need to
know which kind it is talking to.

A2A support bridges the official [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js)
rather than reimplementing the protocol.

**Runtime tier: Node 22.12+.** The upstream binary codec calls `Buffer.from` for
raw binary `Part` serialization. Do not advertise this package for Edge/Worker.
Entrypoints `.`, `./client`, `./server` are aliases over one implementation.
Lifecycle: `borrowed-caller-owned`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-a2a
```

## One roster, two kinds of member

```text
                ┌─────────── AgentTeam roster ───────────┐
 local sessions ┤  reviewer   tester   lead               │
 remote peers   ┤  security (https://security.example.com)│
                └────────────────────────────────────────┘
                                 ▲
                 list_agents · send_message · followup_task · wait_agents
```

| Capability | Local session | Remote A2A peer |
| --- | --- | --- |
| `list_agents` | ✓ | ✓ |
| `followup_task` (wake-up work) | ✓ | ✓ |
| `send_message` (quiet context) | ✓ | ✗ |
| Shares process memory | ✓ | ✗ |

Remote peers support **wake-up delivery only** — A2A has no standard operation
for silently mutating another agent's private history. Protocol limitation
stated honestly, not an SDK shortcut.

## Linking a remote peer

```ts
import { linkA2AAgent } from '@alvin0/ai-agent-sdk-a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  streaming: true,
})
```

```ts
declare function createA2AAgentLink(options: A2AAgentLinkOptions): Promise<A2AAgentLink>
declare function linkA2AAgent(team: A2ALinkableTeam, options: LinkA2AAgentOptions):
  Promise<{ link: A2AAgentLink; unlink(): Promise<void> }>
```

`A2AAgentLink` exposes `agentCard` and `send(input: LinkedAgentSendInput):
Promise<LinkedAgentResult>`, and bounds every hop: request/response/transport
bytes, stream events and bytes, context count and TTL.

Pass `baseUrl` when you want Agent Card discovery. Composition point is
`runtime-team.linkAgent`.

## Discovery, from the model's side

`list_agents` reports, per member: `name`, `kind` (local session | remote A2A
peer), `protocol` (negotiated transport, remote only), `delivery` (which modes
it accepts), `status` (idle | running | pending work).

Delivery modes are **advertised, not guessed**, so the model does not attempt
`send_message` against a peer that only accepts wake-up work.

## Discovery, from the host's side

```ts
harness.workers()           // managed team: currently spawned workers
harness.removeWorker(name)  // retire one
team.messages()             // immutable process-local audit view
await team.whenIdle(name)   // race-safe wait
```

`team.messages()` is an immutable audit view of process-local traffic — who sent
what to whom, with attribution. The record to read when an agent did something
surprising.

## Publishing your agent

```ts
import { createAgentCardFromDefinition } from '@alvin0/ai-agent-sdk-a2a/server'

const card = createAgentCardFromDefinition(ada, {
  url: 'https://ada.example.com/a2a',          // required
  protocolBinding: 'JSONRPC',                   // or 'HTTP+JSON' | 'GRPC'
  version: '1.0.0',
  tags: ['typescript', 'review'],
  securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  requireHttps: true,
})
```

The second argument is **required** — `url` at minimum. The card takes its name
and description from the definition, which is why those fields matter on
`defineAgent()`.

A2A server surfaces return generic internal errors by default. Set
`exposeInternalErrors: true` only on a trusted diagnostic surface.

## In-process teams

See references/orchestration.md for `createManagedAgentTeam`,
`createDefinedAgentTeam`, `spawn_agent`, and `wait_agents`.

```ts
import { AgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
```
