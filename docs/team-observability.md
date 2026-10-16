# Team observability

Managed teams emit `TeamTimelineEvent` as the `type: 'team-timeline'` variant on the existing
`AgentTeamEvent` channel. Use `team: { onEvent }` at construction or `managed.team.subscribe()`.
Existing lifecycle events remain supported. Exhaustive switches need the new variant.
Observability installs no additional bus, model tool, model prompt or delivery cursor.

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

Every fact has a team id, depth (root is zero), optional parentTeamId, per-instance sequence, ISO timestamp
and elapsed monotonic milliseconds. Nested managed teams infer ancestry from the inherited observation
port; hosts can supply parentTeamId/depth explicitly through AgentTeamOptions. Forward each nested team
onEvent channel to the collector as well as its canonical observation port.
Sequence applies to timeline facts only; pair it with team id. A reentrant observer can publish a later
fact before another subscriber receives the earlier one; **consumers must sort by sequence** within each team when presenting a timeline.
Persist events in the host when history is needed. The SDK stores summary state, not an event array.
Callbacks have the existing synchronous best-effort semantics; thrown observer errors are isolated.
These facts do not imply durable delivery or observation-exporter acknowledgement.

| kind | Meaning |
| --- | --- |
| `spawn-requested` | Validated, resolved address/context before slot admission/setup; invalid or already-aborted requests emit only spawn-rejected. Task content is excluded. |
| `spawn-accepted` | Initial task delivered and worker dispatched, or successfully held for dependencies. Setup failures before this boundary are rejected only. |
| `spawn-rejected` | One fact per refused/failed attempt: member, reason (capacity/duplicate/invalid/aborted/setup), stable code, busy, preparing, limit. Unresolved requests use their bounded name or `<unresolved>`. Pre-admission aborts use TEAM_SPAWN_ABORTED. |
| `slot-released` / `member-closed` | Reservation released once, or address detached. Retained results remain separately readable. |
| `spawn-failed` | Setup failure projection, with reason=setup/code; linked to the same spawn-rejected, not another attempt. |
| `member-started` | A session ledger started a run. For a worker this is actual dispatch, after dependency holds. Includes run/conversation ids and activation source/sender. Quiet initial admission, later follow-up, peer message and explicit wake causes remain distinguishable. |
| `model-requested` | A logical SDK model call started, including compaction. Physical provider retries remain canonical observation events. |
| `member-settled` | A run ledger finalized. Includes run id, operation status, duration and canonical `RunUsageReport`. This is the usage accounting event. |
| `worker-settled` | Managed runtime result status: completed, failed, timeout or cancelled. Includes the owning run's usage when known. A later report-bearing fact may upgrade an earlier report-free settlement; prefer the report-bearing fact per member/run. Do not sum this with `member-settled`. |
| `lead-returned` / `team-joined` | Initial raw lead session returned (possibly a provisional yield), or the managed final join completed, with busy/preparing counts. With auto coordination disabled only lead-returned is emitted. |
| `lead-yielded` | Turn yielded for workers, capacity, or an explicit host-hook decision. |
| `lead-woken` | Lead wake admitted with settlement, synthesis, steering, message or host reason. Scheduler coalescing can avoid a model call. |
| `notice-delivered` | A claimed settlement batch entered lead history via mailbox or fallback injection. Lists worker addresses only. |
| `wasted-wake` | The first logical model request after a settlement/synthesis wake has no new team information since the previous lead request. |
| `budget` | Turn-budget exhaustion, worker/pending-input admission refusal, synthesis retry exhaustion, collaboration join deadline or peer credit consumption/refusal. |
| `board-operation` | Successful CAS mutation, with actor, task id, operation, revision and status. Failed/stale mutations emit no success fact. Notes/results/titles are excluded. |

Batch spawning uses these same facts for each item. Successful queued items emit `spawn-requested`
when their setup actually starts, then `spawn-accepted` after dispatch. Atomic overflow/duplicate
refusals emit paired request/rejection facts for each item; invalid input and pre-dispatch queue
cancellation emit rejection only. Queue reservations are excluded from `preparing` capacity counts
and emit no slot release when cancelled, because they never held a slot. A final batch coverage
account emits `notice-delivered` with `delivery: 'injection'` and an empty `workers` list; it advances
team information without claiming or repeating any worker result.

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
including host/model follow-ups, early calls before attachment, and inherited child conversations.
Nested team wrappers attribute each observation to the closest team, preventing duplicate logical calls. The host's capture/checkpoint receipts, audit mode, span methods,
interceptors and policy hooks remain in force. Recording/session composition are internal runtime helpers,
not public AgentTeam methods. Uninstrumented host-created or remote sessions expose roster metadata
but no fabricated model usage. Event construction/deep cloning is skipped without subscribers; snapshots
continue to update and sequence numbers can have gaps after subscribing later.

## Benchmark

The benchmark collector recognizes schema version 1 and deduplicates `(teamId, sequence)`.
It retains content-free `message-accepted` (sender/target/delivery/id) and `member-run-*` metadata
alongside timeline facts for tracing activations after a lead return. Response/task text is excluded
from this metadata channel; canonical model observations remain in the audit.

- `spawns` counts successful dispatches or dependency holds. `spawnAttempts` counts resolved
  requests plus invalid/aborted pre-admission rejections; `spawnsRejected` counts one rejection per
  attempt. After all spawn calls settle, `spawns + spawnsRejected == spawnAttempts`. Attachment alone
  does not count as acceptance; older SDKs without timeline facts retain the attachment fallback.
- `wastedLeadTurns` retains the evidence-fingerprint definition on every branch. `wastedWakes`
  separately counts runtime settlement/synthesis wakes with no new team information.
- Timeline call counts are used only when they equal observed model starts. Lead calls additionally
  match the root team id and root lead conversation. Usage also requires finalized run coverage;
  partial timelines fall back to canonical model observations.
- `memberMetrics` contains per-member/conversation calls, uncached input, cached input, cache writes
  and output from canonical observations. `leadCallInputTokens` contains each root lead call's total
  input buckets (uncached + cache read + cache write); null means missing usage. These fields live in
  result metrics JSON for single and team arms, including no-spawn runs, so F10 can be compared directly.
  Per-member token aggregates are reported subtotals; inspect overall coverage flags.

`teamMetricsSource` identifies timeline availability, `callMetricsSource` identifies the call-count
source, and `usageMetricsSource` identifies finalized team ledgers versus model observations.
Older SDKs retain attachment/evidence fallbacks. Copy identical harness bytes to compared branches.
Offline fixtures validate plumbing, not model-dependent surface costs or quality. Live comparisons
remain reviewer-owned under the plan's N>=3 contract and model policy.
