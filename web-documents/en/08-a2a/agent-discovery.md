# Agent Discovery

Discovery answers two different questions: **what is on the roster right now**
(local) and **what does that remote endpoint claim to be** (Agent Card).

## The roster, from the model's side

Joining a team gives a session a bound `list_agents` tool. The model calls it to
find out who it can talk to.

```text
list_agents → for each member:
                name
                kind         local session | remote A2A peer
                protocol     the negotiated transport, for remote peers
                delivery     which modes it accepts (quiet / wake-up)
                status        idle | running | pending work
```

Two consequences worth designing around:

**The model does not need to know where a peer lives.** A remote peer appears
beside local ones, so `followup_task` works the same either way.

**Delivery modes are advertised, not guessed.** A remote peer reports that it
accepts wake-up work only, so the model does not attempt `send_message` against
it and get a failure.

## The roster, from the host's side

```ts
harness.workers()          // managed team: currently spawned workers
harness.removeWorker(name) // retire one
team.messages()            // immutable process-local audit view
await team.whenIdle(name)  // race-safe wait
```

`AgentTeam.messages()` is an **immutable audit view** of process-local traffic:
who sent what to whom, with attribution. It is the record you read when an agent
did something surprising.

## Team-level invariants

Teams enforce these so you do not have to:

| Invariant | Effect |
| --- | --- |
| Unique names | Two members cannot share an address |
| One local lead | A single coordinator per team |
| Member / message / mailbox limits | Bounded fan-out and queue depth |
| Metadata and UTF-8 message-size limits | No unbounded payload |
| Self-message rejection | An agent cannot message itself |
| Serialized remote dispatch | FIFO per remote target |
| Race-safe idle waiting | `whenIdle()` resolves correctly either way |
| Cancellation and disposal | Team teardown reaches its members |

## Discovering a remote agent

`linkA2AAgent()` discovers the Agent Card, lets the official SDK select a
supported transport, and adds the peer to the same roster used by local agents.

```ts
import { linkA2AAgent } from '@ai-agent-sdk/a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
})
```

### Three construction paths — exactly one required

| Input | Use when | Network at link time |
| --- | --- | --- |
| `baseUrl` | You want Agent Card discovery | Yes — fetches the card |
| `agentCard` | You already fetched or cached the card | No |
| `client` | You already built an official A2A `Client` | No |

Passing `agentCard` directly is how you avoid a discovery round trip on every
cold start — cache the card and hand it over.

### What the card decides

```ts
await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  streaming: true,     // OVERRIDE; omit to follow the card's capability
})
```

The Agent Card advertises the peer's capabilities, including whether it supports
streaming. Omit `streaming` and the SDK follows the card. Pass it only when you
know better than the card does.

JSON-RPC and HTTP+JSON transports are enabled. v0.3 compatibility is **disabled
by default** and enabled explicitly with `legacyCompat: true`.

## Publishing your own card

```ts
import { createAgentCardFromDefinition } from '@ai-agent-sdk/a2a/server'

const agentCard = createAgentCardFromDefinition(reviewer, {
  url: 'https://agents.example.com/reviewer/a2a',
  protocolBinding: 'JSONRPC',
  version: '1.0.0',
  tags: ['review', 'release'],
})
```

The card is generated **from the definition**, so `id`, `name`, and `description`
on your `defineAgent()` become the peer's advertised identity. That is the
practical reason to write a real `description`: it is what other services read
when deciding whether to call you.

Agent Card security schemes are passed through when configured, but are **not**
invented or enforced by this SDK.

## Discovery is observed

Discovery and remote capability operations appear on the observation bus as
`sdk.integration.request` with start/end phases, so a slow or failing Agent Card
fetch is visible as an integration failure rather than an unexplained startup
delay.

## Read next

- [Agent Communication](/en/08-a2a/agent-communication)
- [Remote Agents](/en/08-a2a/remote-agents) — transport and endpoint policy
- [A2A Server](/en/08-a2a/a2a-server)
