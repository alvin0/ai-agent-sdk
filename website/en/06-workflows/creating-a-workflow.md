# Creating a Workflow

A workflow in this SDK is a **composition you write**, not a graph you declare.
There are three shapes, and choosing between them is the only real design
decision.

## Shape 1 — One agent with tools

The simplest workflow. The model decides which tools to call and in what order,
inside the loop's bounds.

```ts
const agent = runtime.agent({
  id: 'migrator',
  model,
  instructions: 'Complete the migration and verify every change.',
  tools: [readFile, writeFile, runTests],
  mode: 'deep',
  maxTurns: 24,
  maxToolCalls: 96,
})

const session = agent.createSession()
const result = await session.run('Migrate the billing module to the v2 API.')
```

Use this when the *steps* are not known in advance but the *capabilities* are.

`mode: 'deep'` adds a completion contract: the turn cannot end until the model's
structural `submit_result` self-check is accepted. That is the SDK's answer to
"the agent stopped too early".

## Shape 2 — Your code orchestrates

When the topology is architecture rather than a runtime decision, write it as
ordinary code.

```ts
const planner = runtime.agent({ id: 'planner', model, instructions: 'Produce a plan.' })
const reviewer = runtime.agent({ id: 'reviewer', model, instructions: 'Find risks.' })
const tester = runtime.agent({ id: 'tester', model, instructions: 'Design verification.' })
const lead = runtime.agent({ id: 'lead', model, instructions: 'Integrate and decide.' })

const plan = await planner.generate(objective)

const [review, tests] = await Promise.all([
  reviewer.generate(plan.text),
  tester.generate(plan.text),
])

const decision = await lead.generate(
  `Plan:\n${plan.text}\n\nReview:\n${review.text}\n\nTests:\n${tests.text}`,
)
```

Each `generate()` is an independent run with its own budget, trace, and report.
Nothing is shared implicitly — which is exactly why this composes safely.

## Shape 3 — An agent team

When agents must talk to **each other**, not just to your code, use a team. Two
concepts, same `AgentTeam` result.

### Managed — the lead decides at runtime

```ts
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core'

const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Own the objective, delegate independent research, and synthesize.',
  }),
  maxWorkers: 6,
})

const answer = await harness.run('Investigate the regression and propose a fix.')
console.log(answer.text, harness.workers())
```

The lead gets a sender-bound `spawn_agent` tool and decides **at runtime** whether
delegation helps, how many specialists it needs, and what bounded task each gets.
Multiple `spawn_agent` calls in one model step are concurrency-safe.

### Composed — you fix the roster

```ts
import { createDefinedAgentTeam } from '@ai-agent-sdk/core'

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

Each definition becomes one persistent session and keeps its identity.
Composed-team members do **not** receive `spawn_agent`, so choosing this concept
cannot silently change the declared topology.

## Choosing

| Question | Answer |
| --- | --- |
| Are the steps known before the run? | Yes → shape 2. No → shape 1 or managed team. |
| Do agents need each other's context? | Yes → team. No → shape 2. |
| Is the roster fixed by architecture? | Yes → composed team. No → managed team. |
| Is one agent with tools enough? | Usually yes. Start there. |

Start with shape 1. Move to shape 2 when you need independent budgets and
traces. Move to a team only when agents must exchange attributed messages.

## The four bound team tools

Joining a team exposes these by default:

| Tool | Does |
| --- | --- |
| `list_agents` | Local and remote targets, protocol, delivery modes, status |
| `send_message` | Quiet context into another **local** session |
| `followup_task` | Serialized work on a local **or remote** target, returns the result |
| `wait_agents` | Blocks until selected scheduled work is idle |

The managed lead additionally receives `spawn_agent`. Set
`team: { team, tools: false }` when only the host may communicate.

**Sender identity is bound at session creation**, so a model cannot forge `from`.

## Owning execution yourself

Below `session.run()` there are two lower entry points, for when you deliberately
own history or every boundary:

```ts
// You own history; the SDK owns execution policy.
for await (const event of runAgent({ mode: 'deep', registry, history, tools, maxTurns: 8 })) { … }

// You own every execution boundary — one turn only.
for await (const event of runTurn({ registry, config, history, tools })) { … }
```

`runTurn()` executes **one turn**. Looping across turns, deciding when the task
is done, and enforcing an overall budget are yours at that level.

## What you never have to write

```text
retry on transient provider failure   → withRetry decorator
one turn at a time per conversation   → session exclusion lock
token / step / tool ceilings          → loop bounds
context overflow recovery             → automatic compaction
cancellation that reaches every tool  → composed signals
a trace tree for the whole flow       → traceId / spanId / parentSpanId
"did anything leak on shutdown?"      → RuntimeCloseReport.unsettledRuns
```

## Read next

- [Sequential Execution](/en/06-workflows/sequential-execution)
- [Parallel Execution](/en/06-workflows/parallel-execution)
- [A2A](/en/08-a2a/) — teams that cross service boundaries
