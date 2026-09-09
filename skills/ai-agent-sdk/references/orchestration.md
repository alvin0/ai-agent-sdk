# Orchestration — flows, modes, teams, gates

**There is no workflow engine.** No `defineWorkflow()`, no `createWorkflow()`,
no `WorkflowStep`, no step graph, no declarative scheduler. Searching the source
for those names returns nothing. What ships instead: the agent loop, tool
scheduling, agent teams, turn hooks, approval boundaries.

A declarative engine would have to own history, retries, cancellation, budgets,
and persistence — things the agent loop already owns with bounds and
observability attached. Two schedulers would then disagree about who enforced
the token ceiling.

So control flow is ordinary TypeScript:

```ts
const plan = await planner.run(objective)
const [review, tests] = await Promise.all([
  reviewer.run(plan.text),
  tester.run(plan.text),
])
const final = await lead.run(`Integrate:\n${review.text}\n${tests.text}`)
```

## Who owns the control flow — pick deliberately

```text
┌─ The MODEL decides ────────────────────────────────────────────┐
│  runtime.agent({ tools, mode: 'deep' })                        │
│  createManagedAgentTeam({ lead })  → spawn_agent at runtime    │
│  Best when the shape of the work is not known in advance.      │
├─ YOUR CODE decides ────────────────────────────────────────────┤
│  await a.run(x); await b.run(y)                                 │
│  createDefinedAgentTeam({ members })                            │
│  hooks.beforeStep → { kind: 'reject' }                          │
│  Best when the topology is architecture, not a runtime choice.  │
├─ A PERSON decides ─────────────────────────────────────────────┤
│  approvals broker per tool call                                 │
│  mode: 'deep-human-in-loop' → request_user_input                │
│  Best when the decision is material and hard to reverse.        │
└────────────────────────────────────────────────────────────────┘
```

Most real systems mix all three: your code fixes the topology, the model decides
tactics inside it, a person gates the irreversible steps.

| You want | The primitive |
| --- | --- |
| Steps in order | Chained `session.run()`, exclusive tools, scheduler barriers |
| Steps at the same time | `isConcurrencySafe`, `maxParallel`, `spawn_agent`, `wait_agents` |
| A branch or a gate | `hooks.beforeStep` → `StepDecision`, `toolChoice`, host code |
| A person to decide | `createApprovalBroker()`, `mode: 'deep-human-in-loop'` |
| Several agents cooperating | `AgentTeam`, managed or composed |
| A completion contract | `mode: 'deep'` and its `submit_result` self-check |

## Execution modes

| Mode | Adds |
| --- | --- |
| `basic` | Plain tool loop |
| `deep` | A completion contract: the turn cannot end until the model's structural `submit_result` self-check is accepted. The SDK's answer to "the agent stopped too early" |
| `deep-human-in-loop` | Also gives the model `request_user_input` for material decisions |

In `deep` mode, `stopReason === 'completed'` is **not** sufficient evidence of
completion — an accepted submission is also required.

## Shape 1 — one agent with tools

```ts
const agent = runtime.agent({
  id: 'migrator', model,
  instructions: 'Complete the migration and verify every change.',
  tools: [readFile, writeFile, runTests],
  mode: 'deep',
  maxTurns: 24,
  maxToolCalls: 96,
})

const result = await agent.createSession().run('Migrate the billing module to the v2 API.')
```

Use when the *steps* are unknown but the *capabilities* are known.

## Shape 2 — your code orchestrates

```ts
const plan = await planner.generate(objective)
const [review, tests] = await Promise.all([
  reviewer.generate(plan.text),
  tester.generate(plan.text),
])
const decision = await lead.generate(`Plan:\n${plan.text}\n\nReview:\n${review.text}`)
```

Each `generate()` is an independent run with its own budget, trace, and report.
Nothing is shared implicitly — which is why it composes safely.

## Shape 3 — agent teams

Use when agents must talk to **each other**, not just to your code. Two
concepts, same `AgentTeam` result; they differ in who owns topology and worker
lifecycle.

```ts
import { createManagedAgentTeam, createDefinedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core'

// Managed — the lead decides at runtime whether and how widely to delegate.
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

// Composed — you fix the roster; identities are architecture.
createDefinedAgentTeam({ registry, team: { id: 'release-team' }, members })
```

Composed-team members do **not** receive `spawn_agent`, so choosing the composed
concept cannot silently change the declared topology.

`runtime.team(options)` is the runtime-level entry point for the same thing.

### Parallel delegation

One `spawn_agent` call creates a real `DefinedAgent` clone and `AgentSession`.
Multiple `spawn_agent` calls in the same model step are concurrency-safe, so
independent work fans out. The lead also gets `list_agents` and `wait_agents`.

`wait_agents` returns as soon as the **first** selected target settles. A
finished worker keeps its `maxWorkers` slot accounting honest.

`maxParallel` (in `runtimeLimits`) caps how many eligible tool calls run at once.

## Branching and gates — `hooks.beforeStep`

```ts
type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }

const session = agent.createSession({
  hooks: {
    beforeStep: ctx => {
      if (budget.exhausted(ctx)) {
        return { kind: 'reject', reason: 'cost budget exhausted for this tenant' }
      }
      return { kind: 'proceed' }
    },
  },
})
```

| Decision | Effect |
| --- | --- |
| `{ kind: 'proceed' }` | The step runs normally |
| `{ kind: 'proceed', prepend }` | Messages are prepended to **that one request** |
| `{ kind: 'reject', reason }` | The step does not run; the reason is recorded |

Choosing the right lever:

```text
"the model should not have this option"  → narrow tools / skills / toolChoice
"this step must not run right now"       → hooks.beforeStep → reject
"a person must decide"                   → approval broker / deep-human-in-loop
```

## The low-level loop

```ts
import { runAgent, runTurn, History, ToolRegistry, buildTraceTree } from '@alvin0/ai-agent-sdk-core/agent'

for await (const event of runAgent({ mode: 'deep', registry, history, tools, maxTurns: 8 })) { /* … */ }
```

Prefer `AgentRuntime` in applications; reach for `runAgent`/`runTurn` only when
you are deliberately replacing the session layer.

## What the SDK still guarantees

You write the flow; you do not write the safety rails — budgets, cancellation
composition, bounded history, usage accounting, and correlated observability
come from the loop regardless of the shape you choose.
