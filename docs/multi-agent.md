# Multi-agent teams

Managed teams let a lead model delegate bounded work and synthesize worker results.
The SDK supplies sessions, scheduling, tools and lifecycle hooks. The host still owns
application tools, credentials, authorization, storage, workspace isolation and UI.

Start with the [offline example](../samples/multi-agent-offline/README.md), which runs
both modes without credentials. The [chat sample](../samples/chat-agents/README.md)
shows streaming, approvals and a conversation-owned team. See the
[Unreleased changelog](../CHANGELOG.md#unreleased) for migration details.

## Choose a shape

| Shape | Use it for | Coordination |
| --- | --- | --- |
| Lead delegates, workers report (default) | Independent research, disjoint code changes, fresh-context review | Lead briefs workers; each terminal result reaches the lead automatically |
| Collaboration (`collaboration: true`) | One problem that needs shared findings and explicit ownership | Members use a shared task board and bounded peer messages; lead joins members and synthesizes |

Keep quick questions, immediate blockers and tightly coupled sequential work local.
Delegation adds model input and coordination cost. Give each worker an objective,
expected output, write scope and verification criteria. Start independent work together,
continue non-overlapping work yourself, and avoid repeating what you delegated.

`delegationMode: 'proactive'` is the default guidance: delegate when useful.
`'explicit'` asks the model to delegate only when the user or host instructions request
it. This is prompt guidance; use `maxDepth: 0` or host admission policy to prohibit spawning.
Collaboration is a separate option, not a third delegationMode value.

For a fixed roster or custom orchestration, use `AgentTeam` / `createDefinedAgentTeam`
instead. Their host messaging and remote transport hooks remain available. The lean
managed model tools address local managed workers and the lead, not remote peers.

## Host setup

This function accepts an already configured `ModelRegistry` and host tools. It does
not register a provider or fetch credentials. For live OpenAI/Codex usage in this repo,
select `gpt-6-luna` or a newer explicitly selected model; report errors without falling
back to an older model.

```ts
import { createManagedAgentTeam, defineAgent, managedAgentRolePresets }
  from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeamOptions, ToolDefinition }
  from '@alvin0/ai-agent-sdk-core/agent'
import type { ModelRegistry } from '@alvin0/ai-agent-sdk-core'

export function makeTeam(
  registry: ModelRegistry,
  tools: readonly ToolDefinition<any>[],
  // Reuse these exact references for inherited guarded tools.
  guards: Pick<NonNullable<ManagedAgentTeamOptions['leadSessionOptions']>,
    'interceptors' | 'approvals'>,
) {
  return createManagedAgentTeam({
    registry,
    lead: defineAgent({
      id: 'lead', provider: 'codex', model: 'gpt-6-luna', mode: 'basic',
      instructions: 'Solve the request. Verify findings before synthesizing.',
      tools, maxTurns: 16,
    }),
    modelToolSurface: 'lean', // default; 'legacy' preserves old tool names/schemas
    delegationMode: 'proactive',
    inheritLeadTools: true,
    leadOnlyTools: ['deploy', 'commit'],
    roles: managedAgentRolePresets({ readOnlyTools: ['read_file', 'search_files'] }),
    collaboration: false, // or { maxPeerTurnsPerPair: 4, joinTimeoutMs: 60_000 }
    maxWorkers: 3,
    maxPendingInputs: 16,
    depth: 0, maxDepth: 1,
    defaultSpawnContext: 'fresh',
    writeScopePolicy: 'reject',
    allowModelWorkerCancellation: false,
    workerTimeoutMs: 120_000,
    leadSessionOptions: { ...guards, runtimeLimits: { maxTotalTokens: 60_000 } },
    workerSessionOptions: { ...guards, runtimeLimits: { maxTotalTokens: 20_000 } },
    onWorkerEvent: (worker, event) => { console.log(worker, event.type) },
  })
}

// const team = makeTeam(registry, tools, guards)
// try {
//   const response = await team.run('Inspect the API and independently review it.', {
//     signal: AbortSignal.timeout(180_000),
//     onEvent: event => { console.log('lead', event.type) },
//   })
//   console.log(response.text)
// } finally {
//   await team.dispose()
//   await team.team.dispose() // dispose the underlying control plane if host-owned here
// }
```

The token limits above apply per session/run, not to a shared team account. A host
that needs an aggregate cap must count usage across every session and abort admission
when that cap is reached. Align host tool and model deadlines with the invocation signal.

### Tool inheritance and roles

Generated workers inherit eligible lead definition/session application tools by default.
Coordination/control tools, tools marked `awaitsPerson`, and `leadOnlyTools` are excluded.
Guarded inheritance requires the **same interceptor array and approval broker references**
in worker session options. Equivalent copies do not satisfy that check. Inherited tool
callbacks may still capture shared host state; scope their filesystem and service access.

`inheritLeadTools: false` opts out and clears cloned lead native tools, skills and skill
IDs. `workerSessionOptions.tools: []` replaces application tools with an empty set; use
the inheritance opt-out too when native tools/skills should also be removed. A
`workerTemplate` or `workerFactory(request)` retains its explicit host capabilities;
`inheritLeadTools` and `leadOnlyTools` do not filter those explicit grants. Explicit
worker session tools replace definition tools. Use `workerSessionOptionsFactory` for
per-worker policy and workspace bindings; defined scoped values override base options,
while undefined values preserve them.

Roles add instructions, usage criteria, optional context and an application-tool
allowlist. An allowlist intersects existing grants; it never supplies implementations.
Restricted roles also disable native tools, skills and program grants, and cap team
access at reporting. The opt-in `managedAgentRolePresets` exports `explorer`, `worker`
and `reviewer`; pass host-verified read-only tools, or explorer/reviewer receive no
application tools. Reviewer forces fresh context. A tool name alone cannot prove safety.

`fresh` (default) gives a worker its task and runtime coordination context. Include all
necessary facts in its brief. `fork` also copies the lead's completed conversation,
with its input-token cost; it excludes the lead's in-flight turn. Role context takes
precedence over the spawn/default context.

## Model-facing tools

These are the default **managed lean** tools; host lifecycle APIs keep their existing
names and richer worker views. Use the exact returned `target` for later model calls.

| Tool | Model arguments and behavior |
| --- | --- |
| `spawn_agent` | `{ task, context?, role?, writes?, dependsOn? }`; returns `{ target, status }`, not the result. `role` is offered only when the host declares roles. |
| `send_input` | `{ target, message, interrupt? }`; lead/full worker queues follow-up work for a worker, or sends context to the lead. Returns acceptance, not completion. `interrupt: true` redirects current work when host policy allows it. |
| `wait_agents` | `{ targets?, timeout_ms? }`; omit targets to join all managed workers. Joins all selected work and returns new results plus `timed_out` / optional `interrupted`. |
| `get_agent_result` | `{ target, field?, offset?, maxBytes? }`; repeatable retained pages of `text`, serialized `structured`, or `error`. Default 6 KiB, maximum 16 KiB. Follow `page.nextOffset` with the same field until null. Offsets are character positions supplied by the SDK, not byte offsets. |
| `close_agent` | `{ target }`; closes retained work and cancels unfinished work by default. With `allowModelWorkerCancellation: false`, unfinished work is protected and interrupt is omitted from the send schema. |

Workers default to `workerTeamTools: 'reporting'`: `send_input` provides context only
outside collaboration; returning their final answer settles their task. `'full'` adds
active worker follow-ups, joins and result reads, but does not grant nested spawning.
`false` removes worker team tools. `depth` / `maxDepth` bound SDK spawning; hosts that
compose nested teams must pass the actual child depth and guard opaque delegation tools.

Declare disjoint `writes` scopes, including the lead's own scope in your host workflow.
They are scheduler declarations, not filesystem authorization or locks on arbitrary
host tools. `dependsOn` references already registered producer instances. The dependent
waits and receives bounded producer evidence; **failed producers also release it** with
failure status, so it must validate its inputs. Worker dependencies and board task
dependencies are separate: creating a board dependency does not schedule a worker DAG.

### Collaboration board and peer messages

`collaboration: true` (or an options object) adds:

| Tool | Purpose |
| --- | --- |
| `task_create` | `{ id, title, blockedBy?, notes? }` creates a pending task; dependencies must already exist. |
| `task_list` | `{ status?, ids? }` lists compact status/revisions/owners/readiness. Supply `ids` to read full notes and results. |
| `task_update` | `{ id, expectedRevision, action, notes?, result? }` compares and sets the latest revision. Actions: claim, release, complete, annotate; lead also has reopen. |

Claim before work. A blocked task can be claimed as a reservation, but work should wait
for `ready: true`, and completion requires dependencies to complete. Release/complete
require the owner or lead. Anyone may annotate, replacing notes rather than appending;
preserve others' findings. On stale revision, reread and reconcile before retrying.
Reopen completed dependents before reopening their prerequisite.

For example: `task_create({ id: 'review', title: 'Review the API' })`, then
`task_update({ id: 'review', expectedRevision: 1, action: 'claim' })`.
Read the resulting revision before completing with `action: 'complete'` and a result.

In collaboration, even reporting workers can use `send_input` to wake idle peers or
steer busy peers. Each accepted peer message consumes a lifetime credit per unordered
pair (including interrupts and messages to busy members). Send actionable evidence,
avoid acknowledgement loops, and return a terminal report as well as board findings.
Task readiness/blocked notices also have bounded per-member budgets. With worker team
tools disabled, workers cannot use this board/message surface.

The lead joins all members before concluding. Idle members with unfinished board tasks
do not establish success: explicitly resume work or report the blockers. State is local
and in memory; persistence, restart recovery and external artifact synchronization are
host responsibilities. See the [board contract](../packages/core/src/agent/team/COLLABORATION.md).

## Result flow and streaming

1. Spawning starts independent work; it never waits for the final report.
2. Workers return final answers. Runtime-attributed settlement notices carry bounded
   text, structured data or explicit partial failure evidence to the lead.
3. Push notices and active joins share one delivery ledger: each outcome is delivered
   once per recipient through these paths. An already delivered result is not repeated
   by later waits. A timed-out or interrupted join can return partial new results.
4. While only workers are running, coordination waits on events with **zero periodic
   lead model calls**. When evidence arrives, it resumes synthesis. Explicitly repeated
   model waits still cost turns; do not busy-poll.
5. `await team.run(...)` joins through synthesis and rejects synthesis failures.
   A raw `team.lead.stream(...)` result can be a provisional yield. Streaming hosts must
   keep member events flowing through `team.onAgentEvent` / `onWorkerEvent` and await
   `team.whenQuiet(signal)` before treating the conversation as settled. The chat sample
   implements this event-driven path; merely seeing a worker's last event is insufficient.

Once-only delivery is process-local, not durable exactly-once across restarts. Injection
into lead history owns notice delivery, even before the model's next request. Explicit
`get_agent_result` pages intentionally repeat evidence and remain available after close;
they are recovery reads, not a stable snapshot across worker reactivation.

Host methods include `spawn`, `workers`, `awaitWorker`, `steer`, `closeWorker`,
`removeWorker`, `whenQuiet` and `dispose`; the underlying `team` exposes messaging and
remote links. Concurrent managed `run()` calls reject. Invocation abort cancels owned
work and its synthesis wake without disposing the reusable team. Aborting a standalone
wait only stops waiting. With `autoLeadCoordination: false`, reports are quiet and the
host must drive later lead turns. Deprecated `holdWaitMs` is accepted but ignored.

## Budgets and cleanup

| Option | Default / boundary |
| --- | --- |
| `maxWorkers` | 7 concurrent/preparing workers; finished work releases slots automatically |
| `team.maxMembers` | `maxWorkers + 1` when the helper creates the control plane; settled managed members release roster slots too |
| `maxPendingInputs` | 64 pending accepted model follow-ups |
| `depth` / `maxDepth` | 0 / 1; host must supply nesting depth |
| `maxTaskBytes` / `maxSpecialtyBytes` | 64 KiB / 8 KiB UTF-8 for spawn briefs |
| `workerTimeoutMs` | 10 minutes of active work; excludes setup and dependency queue time |
| `spawnTimeoutMs` / `closeTimeoutMs` | 30 seconds each; bound setup and shutdown waits |
| `observerTimeoutMs` | 1 second per worker event observer callback |
| `maxDependencyReportBytes` | 8 KiB per producer; larger retained output is paged |
| `writeScopePolicy` | `'reject'`; `'warn'` records overlap, `'off'` skips admission checks |
| `requireWorkerText` | false; clean tool-only work is valid |
| `collaboration.maxPeerTurnsPerPair` | 8 credits per unordered pair for the team's lifetime |
| `collaboration.joinTimeoutMs` | `workerTimeoutMs`, per join; expiry cancels running/pending/preparing members |
| `collaboration.maxTasks` | 128 retained tasks, including completed tasks |
| `collaboration.maxTaskBytes` / `maxBoardBytes` | 16 KiB per serialized task / 1 MiB total board |

Session iteration, token, tool, model and history limits remain independent. A per-join
deadline is not a total run cap; use an invocation signal for a total deadline.
Pair/board notification credits do not reset after a successful round of work.

Finished workers retain addresses and evidence without occupying concurrency slots.
`closeWorker` stops work, removes its managed entry and detaches it when stopped;
explicit result pages retain archived evidence. `removeWorker` also removes a settled
managed entry. Long-lived hosts should plan cleanup and preserve any required evidence
externally. Disposing a managed helper cancels its work; also dispose an underlying control
plane when you own it. Cancellation cannot undo external side effects or forcibly stop
a host callback that ignores its signal.

## Migrate from 0.1.12

The [Unreleased Breaking section](../CHANGELOG.md#breaking) is authoritative.

| Earlier expectation | New behavior / migration |
| --- | --- |
| Model uses `list_agents`, `send_message`, `followup_task`, name-based close | Default is lean. Use returned `target`, `send_input`, `wait_agents({ timeout_ms })`, and `close_agent({ target })`. Set `modelToolSurface: 'legacy'` for old names/schemas. Remote peers stay host hooks. |
| Host defines all delegation strategy; workers lack lead tools | Guidance defaults to proactive and generated workers inherit eligible tools. Set `delegationMode: 'explicit'` and `inheritLeadTools: false` for opt-outs; explicitly configure worker capabilities and guard references. |
| Discovery/waits repeat full outcomes; any-target wait finishes first | `list_agents` is status-only. Wait joins all selected targets and delivers only new evidence, shared with push notices. Use repeatable `get_agent_result` pages for recovery. |
| Finished workers need closing to free concurrency | Slots release automatically; addresses remain. Lean close cancels unfinished work unless protected; legacy close still requires `cancelRunning: true`. Reactivation rechecks slot/write admission. |
| Lead completion is final; managed runs may overlap | Managed `run()` joins synthesis and propagates its failures; concurrent calls reject. Raw lead streaming may yield provisionally. Preserve event consumption and wait for quiet. Invocation abort cancels owned work; standalone wait abort does not. |

Legacy opts out of tool names/schemas only. It retains the new delivery, join, slot,
inheritance and guidance behavior; it does not recreate 0.1.12 polling semantics.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Worker lacks a tool | Check inheritance exclusions, explicit template/factory/tools, role intersection and depth. Role presets need host-provided read-only tool names. |
| Spawn rejects guarded inheritance | Supply the same lead interceptor array and approval broker references to workers, or configure explicit worker tools/policy. |
| Spawn reaches a cap despite some idle workers | Check pending/preparing work, reactivated workers and other local/remote members occupying slots. Settled managed workers already release both managed and roster slots. |
| Wait returns no results | A push or earlier join already delivered them. Read lead history or use explicit result pages; do not spin on settled workers. |
| Stream ends before synthesis / worker approval stalls | Consume member events as well as lead events, keep approval handlers alive, and use `whenQuiet`. Raw lead completion may be provisional. |
| Worker edits overlap or reviewer runs too early | Narrow write scopes and use producer `dependsOn`; board dependencies alone do not schedule workers. Reviewers need an existing artifact. |
| Board update is stale / task cannot complete | Read full task by id, reconcile notes and revision, verify owner and dependency readiness. Claims survive worker close; recover them explicitly. |
| Peer turn limit is exhausted | Lifetime pair credits are spent. Stop reply loops and let the lead coordinate; use a newly scoped team when appropriate. |
| Workers fail or time out | Treat partial text as partial evidence; inspect status/error pages and narrow work. Failed producers release dependents with failure evidence. |
| Runs cost more without improving quality | Keep sequential work local, prefer fresh context for self-contained tasks, and compare matched single/team/collab cohorts with the [benchmark](../test-human/multi-agent-bench/README.md). Offline scripts verify protocol wiring, not model quality or speed. |
