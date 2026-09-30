# Upgrading from 0.1.4 to 0.1.5

These notes cover changes introduced in 0.1.5. For the current release, read
[upgrading-from-0.1.6.md](upgrading-from-0.1.6.md). Check installed typings. Imports,
provider/model/effort configuration, ordinary tools, session `run`/`stream`, and
snapshot/resume remain available. The effort redesign already shipped in 0.1.4.

| Consumer contract | Adjustment |
| --- | --- |
| Short progress narration by default | Set `commentary: 'concise'`; the new default is `auto`. |
| Injection receipt used as persisted sequence | Mid-round receipts are provisional. Input queues behind in-flight output; use persisted history for durable IDs. Snapshots retain pending input. From 0.1.6 a person's input queued during a final answer is answered in the same run; team deliveries still wait for the wake-up. |
| Team relies on SDK planning/delegation prose | Put that strategy in lead/worker instructions. Automatic lead coordination remains on. |
| Every worker must return text | Set `requireWorkerText: true`; clean empty completions are otherwise valid. |
| Absolute `writes` scopes | Use workspace-relative paths; no escaping `..`. Omit scopes for read-only work. |
| Dependency report bound below 4 bytes | Raise it; default remains 8 KiB. |
| End-to-end worker deadline | `workerTimeoutMs` now measures active execution; bound setup/dependency waiting in the host. |
| Hook identifies run by signal object | Signals now compose hook timeout cancellation; forward them and use explicit run/context identity. |

Inspect worker outcomes, including failure status and any retained partial text;
a resolved run Promise does not establish completion. Dependency instances and
write claims are retained across address reuse/running follow-ups. In deep modes,
use the terminal response as final text: an unchanged draft can be retained
without streaming it a second time. Task memory preserves the first objective
as background; it does not override newer conflicting user requests.

```ts
const lead = defineAgent({
  id: 'lead', provider, model,
  instructions: 'Plan, delegate independent work, then synthesize verified results.',
  commentary: 'concise',
})
const team = createManagedAgentTeam({ registry, lead, requireWorkerText: true })
```

These options preserve specific earlier rules, not identical model output.
`StepDecision.messages` is a request-only projection, and `parentCallId` is an
optional child-call field. `AgentTeam.messageByteLimit` is a new getter; custom
structural mocks of that concrete class may need to add it.

For optional APIs read [context-optimization.md](context-optimization.md) and
[tools.md](tools.md). Do not convert ordinary tools to programs or install an
optimizer merely to keep existing code working.
