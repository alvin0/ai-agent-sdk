# Upgrading from 0.1.4 to 0.1.5

This guide covers the changes planned for **0.1.5**, currently unreleased.
Workspace manifests carry 0.1.5. Validate with the workspace or packed artifacts
until the Release workflow publishes that version to npm.

Existing package import routes, provider/model/effort configuration, ordinary
tools, `run`/`stream`, and snapshot/resume remain available. Context optimization
and experimental program tools are optional. The reasoning-effort redesign
listed under 0.1.4 in CHANGELOG is already part of that baseline.

| Area | Change | Application action |
| --- | --- | --- |
| Narration | `commentary` defaults to `auto`, previously `concise` | Set `commentary: 'concise'` when short progress updates are part of your contract. |
| Mid-round input | `session.inject()` queues input after the output of the in-flight request | Do not use its provisional receipt as a durable history ID or assume live history has changed immediately. `snapshot()` retains queued input. From 0.1.6, a person's input queued during a final answer is answered by one more round in the same run; team deliveries still wait for the wake-up. |
| Team strategy | SDK prompts explain lifecycle rather than prescribe a delegation plan | Put required planning, delegation, and synthesis rules in lead/worker instructions. Automatic lead coordination remains on by default. |
| Worker text | Clean completion with empty text is valid | Set `requireWorkerText: true` when your workflow requires a textual report. |
| Write scopes | Absolute/escaping `writes` paths are rejected | Use paths such as `src/file.ts`; omit `writes` for read-only work. Scheduling scopes do not grant filesystem permissions. |
| Report bounds | `maxDependencyReportBytes` must be at least 4 | Raise smaller custom values; the 8 KiB default is unchanged. |
| Worker deadline | `workerTimeoutMs` starts at active execution | Apply a host deadline when the whole workflow, including setup and dependency waiting, must be bounded. |
| Completion status | Incomplete A2A responses are reported as failed | Inspect outcome/status rather than treating a resolved Promise as successful completion. |
| Hook cancellation | Hook callback signals include timeout cancellation | Forward the supplied signal; do not depend on signal object identity. |

For a managed team that requires the earlier narration and textual-report rules:

```ts
const lead = defineAgent({
  id: 'lead', provider, model,
  instructions: 'Plan the work, delegate independent tasks, and synthesize verified results.',
  commentary: 'concise',
})
const team = createManagedAgentTeam({ registry, lead, requireWorkerText: true })
```

This preserves those specific rules, not identical model output or every prior
prompt. Dependency identity, steering ordering, interruption context, and
failure handling have also been corrected.

Deep modes may retain an existing answer after an accepted self-check. The SDK
restores that text and suppresses its control marker from text deltas. Use the
terminal response as the final answer; a second copy of all answer deltas is
not guaranteed. Task memory retains the original objective as background and
instructs the model to follow newer user requests when they conflict.

The optional `StepDecision.messages` projects only the next model request; it
does not rewrite raw history or checkpoint snapshots. `AgentTeam` also exposes
a new `messageByteLimit` getter; custom structural mocks of that concrete class
may need to provide it.

Read the [context optimization guide](context-optimization.md), the
[English migration page](../web-documents/en/01-introduction/upgrading-from-0-1-4.md),
or the [Vietnamese migration page](../web-documents/vi/01-introduction/upgrading-from-0-1-4.md)
for configuration examples and related documentation.
