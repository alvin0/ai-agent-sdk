# Team observability

Managed teams emit `TeamTimelineEvent` as the `type: 'team-timeline'` variant on the existing
`AgentTeamEvent` channel. Use `team: { onEvent }` at construction or `managed.team.subscribe()`.
Existing lifecycle events remain supported. Exhaustive switches need the new variant.
No additional bus, model tool, model prompt or delivery cursor is installed.

```ts
const managed = createManagedAgentTeam({
  registry, lead,
  team: { onEvent(event) {
    if (event.type === 'team-timeline') hostTimeline.record(event)
  } },
})
await managed.run(task)
const summary = managed.snapshot() // also managed.team.snapshot()
```

## Timeline contract (schemaVersion 1)

Every fact has a team id, per-instance sequence, ISO timestamp and elapsed monotonic milliseconds.
Sequence applies to timeline facts only; pair it with team id. A reentrant observer can publish a later
fact before another subscriber receives the earlier one; sort by sequence when presenting a timeline.
Persist events in the host when history is needed. The SDK stores summary state, not an event array.
Callbacks have the existing synchronous best-effort semantics; thrown observer errors are isolated.
These facts do not imply durable delivery or observation-exporter acknowledgement.

| kind | Meaning |
| --- | --- |
| `spawn-requested` | Validated, resolved address/context before slot admission/setup. Counts attempts, including refusals. Task content is excluded. |
| `spawn-failed` | Asynchronous setup failed after admission. Slot refusals instead emit `budget`. |
| `member-started` | A session ledger started a run. For a worker this is actual dispatch, after dependency holds. Includes run id. |
| `model-requested` | A logical SDK model call started, including compaction. Physical provider retries remain canonical observation events. |
| `member-settled` | A run ledger finalized. Includes run id, operation status, duration and canonical `RunUsageReport`. This is the usage accounting event. |
| `worker-settled` | Managed runtime result status: completed, failed, timeout or cancelled. Includes the owning run's usage when known. Do not sum this with `member-settled`. |
| `lead-yielded` | Turn yielded for workers, capacity, or an explicit host-hook decision. |
| `lead-woken` | Lead wake admitted with settlement, synthesis, steering, message or host reason. Scheduler coalescing can avoid a model call. |
| `notice-delivered` | A claimed settlement batch entered lead history via mailbox or fallback injection. Lists worker addresses only. |
| `wasted-wake` | The first logical model request after a settlement/synthesis wake has no new team information since the previous lead request. |
| `budget` | Turn-budget exhaustion, worker/pending-input admission refusal, synthesis retry exhaustion, collaboration join deadline or peer credit consumption/refusal. |
| `board-operation` | Successful CAS mutation, with actor, task id, operation, revision and status. Failed/stale mutations emit no success fact. Notes/results/titles are excluded. |

A wasted wake is a runtime diagnostic, not a semantic judgement of the model's work. Team information
advances for delivered lead messages/notices, steering, completed lead tool operations and board changes.
Ordinary steps within a turn and explicit host/message wakes are excluded. Direct host manipulation of
`managed.lead` history is outside this diagnostic. Settlement notice injection counts as delivery under
the combined team's existing once-only contract; it does not imply the model has consumed it.

## Snapshot and usage

`snapshot()` returns deeply frozen metadata: member identity, attached/retained flag, role, lifecycle
status, attach time, latest start/settlement times, cumulative completed-run duration, logical model
calls, run/active-run counts and cumulative completed-run usage. Active usage is excluded until the
ledger finalizes; `activeRuns` exposes that boundary. `usage` absent means no instrumented run has
finalized, rather than zero cost. Preserve `authoritative` and coverage counts: reported tokens with
missing usage are a subtotal. Estimated usage and budget contributions remain separate.

Closed members remain in the summary until the underlying team is disposed or their address is reused.
Reusing an address starts a new identity summary; use conversation/run ids and persisted timeline events
for history across reuse. `managed.dispose()` stops managed work; `managed.team.dispose()` clears the
underlying team summaries. These are in-memory hooks, not durable state or access-control decisions.

Managed lead and generated worker sessions compose their existing observation ports automatically,
including host/model follow-ups. The host's capture/checkpoint receipts, audit mode, span methods,
interceptors and policy hooks remain in force. `AgentTeam.observeSession(name, options)` provides the
same opt-in composition for host-created sessions; attach that session with the same name. Uninstrumented
or remote sessions expose roster metadata but no fabricated model usage.

## Benchmark

The benchmark collector's structural `teamEvent(unknown)` adapter recognizes schema version 1 and
deduplicates `(teamId, sequence)`. It prefers runtime spawn attempts, logical calls and wasted-wake facts.
It prefers finalized run usage only when all observed model starts are covered; otherwise it preserves
canonical per-model partial evidence. Limits still use the existing canonical observation/checkpoint
path, so waiting for a terminal summary never delays admission enforcement.

`metrics.teamMetricsSource` identifies `timeline-v1` versus `inferred`;
`metrics.usageMetricsSource` identifies `team-ledger` versus `model-events`. Older SDKs retain the
original attachment/evidence-fingerprint fallback. The fallback's repeated-evidence count has a wider
meaning than runtime wasted wakes; inspect the source labels when comparing them. Copy identical harness
bytes to both benchmark branches. Offline fixtures validate plumbing; live quality/cost comparisons
remain reviewer-owned under the plan's N>=3 contract and model policy.
