# Parallel Execution

Three levels of parallelism, each with a different safety contract.

## 1. Independent runs — your code

Separate runs share nothing implicitly, so this is always safe:

```ts
const [review, tests, security] = await Promise.all([
  reviewer.generate(plan.text),
  tester.generate(plan.text),
  auditor.generate(plan.text),
])
```

Each has its own budget, trace, history, and report. Nothing coordinates them —
which is exactly why nothing can corrupt anything.

> **Not** safe: calling `session.run()` twice concurrently on the **same**
> session. The exclusion lock rejects the second call rather than interleaving
> two turns over one history. Use separate sessions.

## 2. Parallel tool calls — fail-closed

Within one turn the model may emit several tool calls at once. Only a call whose
classifier returns **exactly `true`** is eligible to run alongside a sibling.

```ts
const readFile = defineTool({
  name: 'read_file',
  description: 'Read a file at a pinned revision.',
  parameters: { /* … */ },
  parse: raw => Args.parse(raw),
  execute: async ({ path, revision }, ctx) => readAt(path, revision, ctx.signal),
  isConcurrencySafe: () => true,     // pure read of an immutable source
})
```

A throwing or absent classifier means **exclusive**. Both reference
implementations default to exclusive and require an explicit opt-in, because the
failure mode of guessing wrong is **silent data corruption** from two tools
mutating the same state — not a visible error.

### The test for `true`

Return `true` only when the call cannot observe or mutate state another
concurrent call touches.

| Safe | Not safe |
| --- | --- |
| Read at a pinned revision | Read whatever is on disk now, while a sibling writes |
| Query a read replica | Write to the primary |
| Pure computation | Run a shell command |
| Fetch an immutable URL | Anything sharing a cursor, cache, or temp path |

"Probably fine" does not qualify. If you have to reason about interleavings,
return `false`.

### Argument-dependent safety

```ts
isConcurrencySafe: args => args.mode === 'read',
```

The classifier receives the parsed arguments, so one tool can be safe for reads
and exclusive for writes.

### Bounding the width

```ts
runtimeLimits: { /* … */ }   // maxParallel bounds simultaneous safe calls
```

`maxParallel` caps how many eligible calls actually run at once. Combined with
`maxToolCalls` (64 per run) and `maxToolDurationMs`, a wide fan-out cannot
exhaust your downstream.

## 3. Parallel agents — a managed team

`createManagedAgentTeam()` gives the lead a `spawn_agent` tool. **Multiple
`spawn_agent` calls in the same model step are concurrency-safe**, so independent
workers run in parallel.

```ts
const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Delegate independent research, then synthesize the findings.',
  }),
  maxWorkers: 6,
})

const answer = await harness.run('Investigate the regression across all three services.')
console.log(harness.workers())
```

One `spawn_agent` call creates a real `DefinedAgent` clone and `AgentSession`,
attaches it as a peer, delivers the initial task with lead provenance, waits for
its result, and returns that result to the lead's tool loop.

Completed workers stay addressable through `list_agents`, `send_message`, and
`followup_task` until removed with `removeWorker()`.

### Isolating what each worker can touch

```ts
createManagedAgentTeam({
  registry,
  lead,
  maxWorkers: 6,
  workerFactory: ({ name, task, specialty }) => buildSpecialist(name, specialty),
  workerSessionOptionsFactory: request => ({
    tools: toolsFor(request),          // a different catalog per worker
    approvals: brokerFor(request),
    interceptors: [scopeGuard(request)],
  }),
})
```

This is the mechanism that makes parallel agents safe in practice: give each
generated identity its own tool catalog, workspace, and approval broker, so two
workers physically cannot write the same file.

Worker count, team capacity, unique addresses, cancellation, and cleanup are
enforced by the harness.

## Joining: `wait_agents`

A coordinator that synthesizes before its workers finish produces confident
nonsense. `wait_agents` blocks until selected scheduled work is idle.

```ts
// From the lead's own tool loop, the model calls wait_agents.
// From host code:
await team.whenIdle('reviewer')
await team.whenIdle('tester')
```

`whenIdle()` is race-safe — it resolves correctly whether the target is already
idle or still running when you call it.

## Fan-out then fan-in, end to end

```ts
const team = createDefinedAgentTeam({
  registry,
  team: { id: 'release-team' },
  members: [{ agent: lead, role: 'lead' }, { agent: reviewer }, { agent: tester }],
})

// Stage context quietly — no turns start yet.
await Promise.all([
  team.team.sendMessage({ from: 'lead', target: 'reviewer', message: candidate, delivery: 'quiet' }),
  team.team.sendMessage({ from: 'lead', target: 'tester', message: candidate, delivery: 'quiet' }),
])

// Fan out.
await Promise.all([
  team.team.followup('lead', 'reviewer', 'Review the candidate.'),
  team.team.followup('lead', 'tester', 'Verify the candidate.'),
])

// Fan in.
await Promise.all([team.team.whenIdle('reviewer'), team.team.whenIdle('tester')])
const decision = await team.run('lead', 'Integrate the peer findings and decide.')
```

## Traces stay unambiguous

Parallel calls to the **same** tool always receive **distinct span ids**, while the
tool call id remains the correlation id. `buildTraceTree()` projects
`span-start` / `span-end` events into an immutable process tree, so a fan-out
renders as a real call graph rather than a flat log.

## Failure semantics

| Situation | Behaviour |
| --- | --- |
| One parallel tool fails | Its sibling still commits; the batch commits together |
| A tool calls `concludeTurn()` | The turn ends **after** the whole batch commits |
| A tool fails | It can never end the turn — `concludesTurn` is typed `never` on failure |
| One worker fails | Its result is a failure the lead reads; other workers continue |
| The run is cancelled | Cancellation composes and reaches every in-flight tool signal |

That "batch commits together" rule is what makes parallel dispatch predictable: a
sibling's completed work is never discarded because another call ended the turn.

## Read next

- [Sequential Execution](/en/06-workflows/sequential-execution)
- [Tool Execution](/en/03-tools/tool-execution)
- [A2A](/en/08-a2a/) — parallelism across services
