# Agent-to-agent collaboration and A2A Protocol

The SDK combines two layers behind one agent roster:

- `AgentTeam` provides Codex/DeepSeek-style collaboration between long-lived
  in-process `AgentSession`s: roster discovery, quiet context injection,
  wake-up follow-ups, sender identity, serialized work, and an audit log.
- `@ai-agent-sdk/a2a/client` and `@ai-agent-sdk/a2a/server` use the official
  [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) implementation of A2A
  Protocol v1.0 for Agent Card discovery and remote JSON-RPC or HTTP+JSON calls.

Install `@ai-agent-sdk/a2a` alongside `@ai-agent-sdk/core/agent`. This protocol bridge
is currently Node-elevated: the upstream binary codec in `@a2a-js/sdk@1.1.0`
calls `Buffer.from`. Text paths happen to work in strict Workers, but the package
must not be deployed as a Universal/Edge package until its committed binary
promotion guard passes. The former `@ai-agent-sdk/a2a/client` and
`@ai-agent-sdk/a2a/server` subpaths remain compatibility aliases.

This distinction matters. Protocol interoperability alone does not implement a
local harness scheduler, while an in-process mailbox cannot communicate with an
agent in another service. `AgentTeam` now routes both kinds of target.

## Two orchestration concepts

Both concepts below produce the same `AgentTeam`. They differ only in who owns
team topology and worker lifecycle.

### 1. Managed dynamic team

Use `createManagedAgentTeam()` for Codex/DeepSeek-harness behavior. The lead gets
a sender-bound `spawn_agent` tool and decides at runtime whether delegation is
useful, how many specialists are needed, and what bounded task each receives.

```ts
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core'

const leadDefinition = defineAgent({
  id: 'lead',
  instructions: 'Own the objective, delegate independent research, and synthesize.',
})

const harness = createManagedAgentTeam({
  registry,
  lead: leadDefinition,
  maxWorkers: 6,
  // Optional. Defaults to cloning the lead configuration for each worker.
  workerTemplate: specialistDefinition,
})

const answer = await harness.run('Investigate the regression and propose a fix.')
console.log(answer.text, harness.workers())
```

One `spawn_agent` call creates a real `DefinedAgent` clone and `AgentSession`,
attaches it as a peer, delivers the initial task with lead provenance, waits for
its result, and returns that result to the lead's tool loop. Multiple calls in
the same model step are concurrency-safe, so independent workers run in parallel.
Completed workers stay addressable through `list_agents`, `send_message`, and
`followup_task` until removed with `removeWorker()`.

For full control over generated definitions, provide
`workerFactory({ name, task, specialty })`. Hosts can also call `harness.spawn()`
directly. `workerSessionOptionsFactory(request)` can bind a different tool
catalog, workspace, approval broker, or interceptor set to every generated
identity. Worker count, team capacity, unique addresses, cancellation, and
cleanup are enforced by the harness.

### 2. Pre-defined composed team

Use `createDefinedAgentTeam()` when agent identities, models, instructions,
skills, tools, or policies are architecture rather than runtime decisions.

```ts
import { createDefinedAgentTeam, defineAgent } from '@ai-agent-sdk/core'

const lead = defineAgent({
  id: 'lead',
  instructions: 'Coordinate the release and synthesize peer evidence.',
})
const reviewer = defineAgent({
  id: 'reviewer',
  instructions: 'Review changes and report concrete risks.',
})
const tester = defineAgent({
  id: 'tester',
  instructions: 'Design and execute focused verification.',
})

const composed = createDefinedAgentTeam({
  registry,
  team: { id: 'release-team' },
  members: [
    { agent: lead, role: 'lead' },
    { agent: reviewer },
    { agent: tester },
  ],
})

await composed.run('lead', 'Prepare release abc123.')
await composed.team.followup('lead', 'reviewer', 'Review abc123.')
```

Each definition becomes one persistent session and keeps its original identity.
Per-member registry and session options are supported. The returned team can
still link remote A2A peers, so a composed topology may mix local specialist
agents and external services.

### Low-level manual composition

```ts
import { AgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'

const team = new AgentTeam({ id: 'release-team', maxMembers: 8 })

const lead = defineAgent({
  id: 'lead',
  instructions: 'Coordinate the release and ask peers for evidence.',
}).createSession({ registry, team: { team, role: 'lead' } })

defineAgent({
  id: 'reviewer',
  instructions: 'Review changes and report concrete risks.',
}).createSession({ registry, team: { team } })

// Durable local context without starting a model turn.
await team.sendMessage({
  from: 'lead',
  target: 'reviewer',
  message: 'The candidate commit is abc123.',
  delivery: 'quiet',
})

// Process now, or immediately after the target's current turn.
await team.followup('lead', 'reviewer', 'Review abc123 and report back.')
await team.whenIdle('reviewer')
```

## Link a remote A2A agent

`linkA2AAgent()` discovers the Agent Card, lets the official SDK select a
supported transport, and adds the peer to the same roster used by local agents.

```ts
import { linkA2AAgent } from '@ai-agent-sdk/a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  // Optional override; otherwise follows the Agent Card capability.
  streaming: true,
})

const receipt = await team.followup(
  'lead',
  'security',
  'Audit release abc123 and return only concrete blockers.',
)

console.log(receipt.result?.text, receipt.result?.taskId)
```

The client supports three construction paths: `baseUrl` for Agent Card
discovery, an already fetched `agentCard`, or an official A2A `Client`. Exactly
one is required. JSON-RPC and HTTP+JSON transports are enabled; v0.3 compatibility
is disabled by default and can be enabled explicitly with `legacyCompat: true`.

One remote A2A `contextId` is retained per `(team, sender)` so later
`followup_task` calls resume the same remote conversation. Dispatches to the same
remote target are FIFO. Streaming lifecycle events can be observed with
`onStreamEvent`.

The client is deployment-policy neutral. It accepts standard HTTP/HTTPS and
private endpoints unless the host opts into constraints. An internet-facing
host can set `requireHttps: true`, `allowPrivateNetwork: false`,
`allowRedirects: false`, and an exact `allowedOrigins` list (or provide its own
`fetch`/`validateEndpoint`). Request, response, HTTP-body, stream event/byte,
context-count, TTL, and timeout budgets are configured independently.

Remote peers support wake-up delivery only because A2A has no standard operation
for silently mutating another agent's private history. `send_message` therefore
targets local sessions; `followup_task` targets either local or remote agents.

## Expose a DefinedAgent as an A2A server

```ts
import {
  createAgentCardFromDefinition,
  createDefinedAgentA2AServer,
} from '@ai-agent-sdk/a2a/server'

const reviewer = defineAgent({
  id: 'reviewer',
  name: 'Release Reviewer',
  description: 'Reviews release candidates and reports concrete risks.',
  instructions: 'Review carefully and return evidence-backed findings.',
})

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

`requestHandler` is the official transport-neutral `DefaultRequestHandler`.
Mount it with the official Express JSON-RPC/REST handlers, gRPC service, or a
custom transport. Keeping HTTP framework code outside this package avoids
forcing Express or gRPC dependencies on every SDK consumer.

The bridge implements the official task lifecycle: initial `Task`, `WORKING`,
artifact update, then `COMPLETED`, `FAILED`, or `CANCELED`. A session is retained
per `(session owner, A2A contextId)`, so a new task in an existing owned context
sees prior messages without sharing history across owners. By default the owner
is the authenticated A2A principal when one exists, otherwise `anonymous`.
`sessionOwner(context)` lets a host choose any boundary such as a user, device,
workspace, or API client without the SDK imposing a tenant model.
Inbound messages are recorded with `source.kind === 'a2a-message'` and their
protocol `contextId`, `messageId`, and `taskId`.

For request-specific registries, tools, or policies, provide
`createSession(context)` instead of a shared `registry`. Authentication is also
a host policy: set `requireAuthenticated: true` only when the surrounding
transport supplies an authenticated `User`. Agent Card security schemes are
passed through when configured, but are not invented or enforced by this SDK.

This package is an SDK, not a production control plane. It supplies bounded
state, TTL, cancellation/disposal, error sanitization, owner scoping, and policy
hooks. The embedding service remains responsible for authentication middleware,
durable stores, rate limiting, network/DNS enforcement, secrets, deployment,
and observability backends.

## Model tools and guarantees

Joining a team exposes four sender-bound tools by default:

- `list_agents` returns local and remote targets, protocol, delivery modes, and
  current status;
- `send_message` injects quiet context into another local session;
- `followup_task` starts serialized work on a local or remote target and returns
  the remote task/message result when applicable;
- `wait_agents` blocks until selected scheduled work is idle, preventing a
  coordinator from synthesizing before local workers finish.

The managed lead additionally receives `spawn_agent`. Pre-defined composed-team
members do not receive it, so choosing the composed concept cannot silently
change the declared topology.

Set `team: { team, tools: false }` when only the host may communicate. The sender
identity is bound at session creation, so a model cannot forge `from`.

Local acceptance means the target history owns an attributed user-role message.
Wake-up work waits behind an active turn and calls `runPending()` exactly once
for the accepted context. `AgentTeam.messages()` exposes an immutable process-local
audit view. Teams also enforce unique names, one local lead, member/message/
mailbox limits, metadata and UTF-8 message-size limits, self-message rejection,
serialized remote dispatch, race-safe idle waiting, cancellation, and disposal.

`AgentSession.inject()`, `runPending()`, and `whenIdle()` remain available as
lower-level primitives, but most applications should use `AgentTeam`.

## Live stress acceptance

Run `npm run human:a2a-managed` and `npm run human:a2a-defined` to exercise both
concepts against a real provider. Both build a runnable LaunchPad Ops website:
three concurrent/scheduled product engineers implement independently tested
vertical slices, compact their own context, and return attributed code handoffs.
The coordinator integrates the responsive UI and the host independently verifies
unit tests, build output, and the final `dist/` artifact. Each agent receives an
exact write allowlist. Model-requested npm-shaped gates are translated to fixed
Node permission-model invocations with a minimal environment; package scripts,
network, subprocesses, and access outside the disposable workspace are denied.
Host-owned fixture/build inputs are hash-verified after the run.
See [`test-human/a2a-stress/README.md`](../test-human/a2a-stress/README.md).
