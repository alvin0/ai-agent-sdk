# Upgrading from 0.1.4 to 0.1.5

This page describes changes introduced in **0.1.5**. The workspace now targets
0.1.7; see [upgrading from 0.1.6](/en/01-introduction/upgrading-from-0-1-6)
for the latest completion, steering and streaming changes.

Existing import routes, provider/model/effort configuration, ordinary tools,
`run`/`stream`, and snapshot/resume remain available. The effort redesign in the
0.1.4 changelog is already part of the baseline. New optimization/program APIs
are optional; an existing application does not need to adopt them.

## Changes to application behavior

| Area | New behavior | What to check |
| --- | --- | --- |
| `commentary` | Defaults to `auto`, previously `concise` | Set `concise` explicitly for short progress updates. |
| `session.inject()` | Mid-round input queues behind in-flight output | Receipt is provisional, not a durable history sequence. Snapshot retains queued input. From 0.1.6, a person's input queued during a final answer is answered in the same run. |
| Managed strategy | Prompts explain lifecycle instead of prescribe a plan | Put required planning, delegation, and synthesis in host instructions. |
| Worker text | A clean empty completion is valid | Set `requireWorkerText: true` when a text report is required. |
| `writes` | Only workspace-relative, non-escaping scopes are accepted | Use `src/file.ts`; omit for readers. Scopes are scheduling declarations, not permissions. |
| Dependency preview | `maxDependencyReportBytes` must be at least 4 | The 8 KiB default is unchanged; full reports remain retrievable. |
| Worker timeout | `workerTimeoutMs` measures active execution | Add a host deadline to bound setup and dependency waiting too. |
| Hook signal | Includes timeout cancellation | Forward the supplied signal; do not rely on its object identity. |

Automatic lead coordination remains enabled by default. `autoLeadCoordination:
false` opts into host-driven scheduling; `workerTeamTools` defaults to
`reporting` and also accepts `full` or false.

```ts
const lead = defineAgent({
  id: 'lead', provider, model,
  instructions: 'Plan, delegate independent work, then synthesize verified results.',
  commentary: 'concise',
})
const team = createManagedAgentTeam({ registry, lead, requireWorkerText: true })
```

This retains those specific rules, not identical model output. Dependency
identity, bounded close/write claims, and incomplete A2A outcomes have been
corrected; inspect completed/failed status rather than Promise resolution.

## History and final answers

An injection made during a fixed model request is delivered after its output,
before preparation of a later request. The low-level live history need not yet
contain it, while `snapshot()` includes pending input in the existing v1 format.
Checkpoint failure drains input before recovery/retry hooks.

Task memory retains the original objective as background. Newer user requests
supersede conflicting retained objectives/constraints. Interrupted turns record
context so the next request can redirect the task.

After an accepted deep-mode self-check, the SDK can retain the earlier answer.
Its control marker is suppressed and the terminal response carries the restored
text. Reconcile a streaming UI with that response; a second full sequence of
answer deltas is not guaranteed.

`StepDecision.messages` projects a single model request without rewriting raw
history/checkpoint snapshots. `AgentTeam.messageByteLimit` is a new getter;
custom structural mocks of that concrete class may need to provide it.

## Optional additions

- [Context optimization](/en/05-memory/context-optimization): repeated observations,
  archived milestones, and exact-line evidence reduction.
- [Program tools](/en/12-experimental/programmatic-tools): explicit grants, nested
  child calls, output validation, and action fusion.
- [Lifecycle](/en/02-agents/lifecycle): steering and request projections.
- [Streaming](/en/02-agents/streaming): final text and completion evidence.
