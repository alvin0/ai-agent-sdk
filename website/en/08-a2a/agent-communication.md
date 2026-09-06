# Agent Communication

## The four bound tools

Joining a team exposes these to the model by default:

| Tool | Target | Effect |
| --- | --- | --- |
| `list_agents` | — | Local and remote targets, protocol, delivery modes, status |
| `send_message` | **Local only** | Injects quiet context into another session |
| `followup_task` | Local **or remote** | Starts serialized work, returns the result |
| `wait_agents` | Local | Blocks until selected scheduled work is idle |

The managed lead additionally receives `spawn_agent`.

```ts
// Only the host may communicate; the model gets no team tools.
defineAgent({ id: 'worker', instructions: '…' })
  .createSession({ registry, team: { team, tools: false } })
```

## Sender identity cannot be forged

**Sender identity is bound at session creation.** A model cannot set `from` — it
is not a parameter the model controls.

```ts
const lead = defineAgent({ id: 'lead', instructions: '…' })
  .createSession({ registry, team: { team, role: 'lead' } })
```

That is what makes the audit view trustworthy: every message in
`team.messages()` is attributed to the session that actually sent it, not to
whatever the model claimed.

## Two delivery modes

```ts
// Quiet: durable context, no turn starts, an idle agent stays idle.
await team.sendMessage({
  from: 'lead',
  target: 'reviewer',
  message: 'The candidate commit is abc123.',
  delivery: 'quiet',
})

// Wake-up: work happens — now, or immediately after the target's current turn.
await team.followup('lead', 'reviewer', 'Review abc123 and report back.')
await team.whenIdle('reviewer')
```

| Mode | Starts a turn | Local | Remote |
| --- | --- | --- | --- |
| `quiet` | No | ✓ | ✗ |
| Wake-up (`followup`) | Yes | ✓ | ✓ |

That separation is the useful part: you can stage several inputs quietly and then
trigger **one** turn that sees all of them, instead of paying for a turn per
input.

Remote peers support wake-up only, because A2A has no standard operation for
silently mutating another agent's private history.

## What "accepted" means locally

Local acceptance means the target's history **owns an attributed user-role
message**. It is not a side channel — the message is in the transcript, with its
sender recorded.

Wake-up work waits behind an active turn and calls `runPending()` **exactly
once** for the accepted context. It does not interrupt the turn in progress, and
it does not double-run when several messages arrive while the agent is busy.

## Joining before synthesizing

A coordinator that summarizes before its peers finish produces confident
nonsense. `wait_agents` exists for that.

```ts
// The model calls wait_agents from its own tool loop.
// From host code:
await Promise.all([team.whenIdle('reviewer'), team.whenIdle('tester')])
const decision = await composed.run('lead', 'Integrate the peer findings and decide.')
```

`whenIdle()` is **race-safe** — it resolves correctly whether the target is
already idle or still running when you call it.

## Dynamic delegation

In a managed team the lead gets `spawn_agent` and decides at runtime whether
delegation helps.

```ts
const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Own the objective, delegate independent research, and synthesize.',
  }),
  maxWorkers: 6,
  workerTemplate: specialistDefinition,   // defaults to cloning the lead
})
```

One `spawn_agent` call creates a real `DefinedAgent` clone and `AgentSession`,
attaches it as a peer, delivers the initial task **with lead provenance**, waits
for its result, and returns that result to the lead's tool loop.

**Multiple `spawn_agent` calls in the same model step are concurrency-safe**, so
independent workers run in parallel. Completed workers stay addressable through
`list_agents`, `send_message`, and `followup_task` until removed with
`removeWorker()`.

### Isolating generated identities

```ts
createManagedAgentTeam({
  registry,
  lead,
  maxWorkers: 6,
  workerFactory: ({ name, task, specialty }) => buildSpecialist(name, specialty),
  workerSessionOptionsFactory: request => ({
    tools: toolsFor(request),        // a different catalog per worker
    approvals: brokerFor(request),
    interceptors: [scopeGuard(request)],
  }),
})
```

This is what makes parallel delegation safe in practice: each generated identity
gets its own tool catalog, workspace, and approval broker, so two workers
physically cannot write the same file.

## Manual composition

For full control, wire the team yourself:

```ts
import { AgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'

const team = new AgentTeam({ id: 'release-team', maxMembers: 8 })

const lead = defineAgent({ id: 'lead', instructions: '…' })
  .createSession({ registry, team: { team, role: 'lead' } })

defineAgent({ id: 'reviewer', instructions: '…' })
  .createSession({ registry, team: { team } })
```

`AgentSession.inject()`, `runPending()`, and `whenIdle()` remain available as
lower-level primitives, but most applications should use `AgentTeam`.

## The audit trail

```ts
const log = team.messages()   // immutable, process-local
```

Every accepted message with its sender, target, delivery mode, and time.
Combined with per-run `traceId` / `spanId`, a multi-agent flow reconstructs
exactly — which is the difference between debugging a team and guessing about it.

## Read next

- [Remote Agents](/en/08-a2a/remote-agents)
- [Parallel Execution](/en/06-workflows/parallel-execution)
