# A2A — Overview

The SDK combines **two layers behind one agent roster**:

| Layer | What it is | Package |
| --- | --- | --- |
| `AgentTeam` | Collaboration between long-lived **in-process** sessions | `@ai-agent-sdk/core/agent` |
| A2A Protocol v1.0 | Agent Card discovery and **remote** JSON-RPC / HTTP+JSON calls | `@ai-agent-sdk/a2a` |

The distinction matters. Protocol interoperability alone does not implement a
local scheduler, and an in-process mailbox cannot reach an agent in another
service. `AgentTeam` routes **both** kinds of target through the same roster, so
a model calling `followup_task` does not need to know which kind it is talking
to.

A2A support is the official
[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) implementation — the SDK
bridges to it rather than reimplementing the protocol.

> **Runtime tier: Node.** `@ai-agent-sdk/a2a` is currently **Node-elevated**
> because the upstream binary codec calls `Buffer.from` for raw binary `Part`
> serialization. Text, structured data, URLs, and binary values work in Node.
> Text paths happen to work in strict Workers, but the package must not be
> advertised for Edge/Worker runtimes until its committed negative promotion gate
> passes without Node globals. See [Experimental](/en/12-experimental/).

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/a2a
```

## One roster, two kinds of member

```text
                    ┌─────────── AgentTeam roster ───────────┐
                    │                                         │
   local sessions ──┤  reviewer   tester   lead               │
                    │                                         │
   remote peers   ──┤  security (https://security.example.com)│
                    │                                         │
                    └─────────────────────────────────────────┘
                                     ▲
                     list_agents · send_message · followup_task · wait_agents
```

| Capability | Local session | Remote A2A peer |
| --- | --- | --- |
| `list_agents` | ✓ | ✓ |
| `followup_task` (wake-up work) | ✓ | ✓ |
| `send_message` (quiet context) | ✓ | ✗ |
| Shares process memory | ✓ | ✗ |

Remote peers support **wake-up delivery only**, because A2A has no standard
operation for silently mutating another agent's private history. That is a
protocol limitation stated honestly, not an SDK shortcut.

## The two team concepts

Both produce the same `AgentTeam`. They differ only in **who owns topology and
worker lifecycle**.

```ts
// The lead decides at runtime whether to delegate, and to how many.
createManagedAgentTeam({ registry, lead, maxWorkers: 6 })

// You fix the roster; identities are architecture, not a runtime choice.
createDefinedAgentTeam({ registry, team: { id: 'release-team' }, members })
```

Composed-team members do **not** receive `spawn_agent`, so choosing the composed
concept cannot silently change the declared topology.

## Both directions

| Direction | Entry point |
| --- | --- |
| **Consume** — link a remote agent into your roster | `@ai-agent-sdk/a2a/client` → `linkA2AAgent()` |
| **Publish** — expose your `DefinedAgent` as an A2A server | `@ai-agent-sdk/a2a/server` → `createDefinedAgentA2AServer()` |

## What stays with the host

This package is an **SDK, not a production control plane**. It supplies bounded
state, TTL, cancellation and disposal, error sanitization, owner scoping, and
policy hooks.

The embedding service remains responsible for authentication middleware, durable
stores, rate limiting, network and DNS enforcement, secrets, deployment, and
observability backends.

## In this chapter

| Page | Answers |
| --- | --- |
| [Agent Discovery](/en/08-a2a/agent-discovery) | Agent Cards, the roster, and how a model finds a peer |
| [Agent Communication](/en/08-a2a/agent-communication) | The four bound tools, delivery modes, sender identity |
| [Remote Agents](/en/08-a2a/remote-agents) | Linking peers, context retention, transport and endpoint policy |
| [A2A Server](/en/08-a2a/a2a-server) | Exposing an agent, task lifecycle, session ownership |

## Live acceptance

```bash
npm run human:a2a-managed
npm run human:a2a-defined
```

Both exercise a real provider: concurrent product engineers implement
independently tested vertical slices, compact their own context, and return
attributed handoffs while a coordinator integrates the result. Each agent
receives an **exact write allowlist**; package scripts, network, subprocesses,
and access outside the disposable workspace are denied.
