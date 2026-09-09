# Workflows — Overview

> **There is no workflow engine.** The SDK ships no `defineWorkflow()`, no step
> graph, no DSL, and no scheduler you configure declaratively. Searching the
> source for `defineWorkflow`, `createWorkflow`, or `WorkflowStep` returns
> nothing.
>
> What it ships instead are **orchestration primitives**: the agent loop, tool
> scheduling, agent teams, turn hooks, and approval boundaries. This chapter
> documents how to build sequential, parallel, conditional, and
> human-gated flows out of them.

## The primitives

| You want | The primitive | Where |
| --- | --- | --- |
| Steps in order | Chained `session.run()`, exclusive tools, scheduler barriers | [Sequential](/en/06-workflows/sequential-execution) |
| Steps at the same time | `isConcurrencySafe`, `maxParallel`, `spawn_agent`, `wait_agents` | [Parallel](/en/06-workflows/parallel-execution) |
| A branch or a gate | `TurnHooks.beforeStep` → `StepDecision`, `toolChoice`, host code | [Conditional](/en/06-workflows/conditional-execution) |
| A person to decide | `createApprovalBroker()`, `mode: 'deep-human-in-loop'` | [Human Approval](/en/06-workflows/human-approval) |
| Several agents cooperating | `AgentTeam`, managed or composed | [Creating a Workflow](/en/06-workflows/creating-a-workflow) |
| A completion contract | `mode: 'deep'` and its `submit_result` self-check | [Creating a Workflow](/en/06-workflows/creating-a-workflow) |

## Who owns the control flow

That is the real question, and the SDK gives you three answers.

```text
┌─ The MODEL decides ─────────────────────────────────────────────┐
│  runtime.agent({ tools, mode: 'deep' })                         │
│  createManagedAgentTeam({ lead })   → spawn_agent at runtime    │
│  Best when the shape of the work is not known in advance.       │
└─────────────────────────────────────────────────────────────────┘
┌─ YOUR CODE decides ─────────────────────────────────────────────┐
│  await a.run(x); await b.run(y)                                  │
│  createDefinedAgentTeam({ members })                             │
│  hooks.beforeStep → { kind: 'reject' }                           │
│  Best when the topology is architecture, not a runtime choice.   │
└─────────────────────────────────────────────────────────────────┘
┌─ A PERSON decides ──────────────────────────────────────────────┐
│  approvals broker per tool call                                  │
│  mode: 'deep-human-in-loop' → request_user_input                 │
│  Best when the decision is material and reversible only by hand. │
└─────────────────────────────────────────────────────────────────┘
```

Most real systems mix all three: your code fixes the topology, the model decides
tactics inside it, and a person gates the irreversible steps.

## Why there is no engine

A declarative engine would have to own history, retries, cancellation, budgets,
and persistence — the same things the agent loop already owns, with bounds and
observability attached. Two schedulers would then disagree about which one
enforced the token ceiling.

The consequence for you: **control flow is ordinary TypeScript**. It is testable
with your normal tools, and it does not need a second mental model.

```ts
// A "workflow" is just this.
const plan = await planner.run(objective)
const [review, tests] = await Promise.all([
  reviewer.run(plan.text),
  tester.run(plan.text),
])
const final = await lead.run(`Integrate:\n${review.text}\n${tests.text}`)
```

## What the SDK still guarantees

You write the flow, but you do not write the safety rails:

| Guarantee | Where it comes from |
| --- | --- |
| 16 model steps, 64 tool calls, 500,000 token ceiling per run | Loop bounds, host-configurable |
| Exact-repeat and short-cycle detection | Loop bounds |
| One turn at a time per conversation | Session exclusion lock |
| Parallel calls never share mutable state by accident | Fail-closed `isConcurrencySafe` |
| Cancellation composes across runtime, run, and tool | Composed signals |
| Every step is traced with `traceId` / `spanId` / `parentSpanId` | Observation bus |
| Shutdown reports unsettled work | `RuntimeCloseReport` |

## In this chapter

| Page | Answers |
| --- | --- |
| [Creating a Workflow](/en/06-workflows/creating-a-workflow) | Choosing a topology, and the three composition shapes |
| [Sequential Execution](/en/06-workflows/sequential-execution) | Ordering that actually holds |
| [Parallel Execution](/en/06-workflows/parallel-execution) | Concurrency that is safe by default |
| [Conditional Execution](/en/06-workflows/conditional-execution) | Branching, gating, and rejecting a step |
| [Human Approval](/en/06-workflows/human-approval) | Blocking on a person, and resuming correctly |
