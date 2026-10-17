# Managed team collaboration

`createManagedAgentTeam({ registry, lead, collaboration: true })` opts into solving
one problem together. Omit `collaboration` to keep the existing delegation mode.
The SDK supplies in-memory state and scheduling hooks; the host owns tools,
models, filesystem policy and session recovery. Hosts and benchmark runners can
check the stable exported `MANAGED_TEAM_FEATURES.collaboration === true` flag.
The board implementation class is internal; use `team.collaboration?.board`.

The lead and reporting workers receive `task_create`, `task_list`, `task_update`
and waking `send_input`. Full workers also receive `wait_agents` and retained result reads.
The lean lead additionally has spawn/close controls. `modelToolSurface: 'legacy'` keeps waking
`send_message`; its duplicate `followup_task` alias is removed in collaboration mode.
Host delivery APIs retain their behavior. `workerTeamTools: false` disables worker team tools.
Generated workers follow the guarded application-tool inheritance and role restrictions documented
in `docs/managed-team-delegation.md`. Worker results are pushed automatically through the shared
settlement delivery ledger; board notes/results supplement those reports.

Create tasks with stable local `id` and `title`. Optional `blockedBy` names existing
tasks; references and cycles are checked on every change. Dependencies and titles
are fixed at creation. The host owns filesystem admission and coordination of edits;
task records do not carry advisory write scopes.

Every `task_update` requires `id`, `expectedRevision`, and `action`:

- `claim`: reserve a pending task for the caller, even while blocked. Work only
  when `ready=true`.
- `release`: return claimed work to pending, dropping the owner; owner or lead only.
- `complete`: mark ready, claimed work completed, optionally retaining `result`;
  owner or lead only.
- `reopen`: lead-only; return completed work to pending and clear its owner/result.
  Reopen completed dependents first so their old results cannot masquerade as current.
- `annotate`: replace `notes`, available to every member, including on completed tasks.

Updates may include notes; completion may also include a result. A stale revision
fails without changing anything; list again before retrying. Only the lead's
`task_update` schema offers `reopen`; the board also rejects forged worker requests.
`task_list` defaults
to compact records containing id, title, revision, status, owner, dependencies and
readiness, with no notes/result bodies. Optional `status` filters by `pending`,
`claimed` or `completed`. Optional `ids: ['task-id']` selects full task records,
including notes/results; both filters may be combined. Closed members' claimed
tasks remain visible for the lead to release or report.

`team.collaboration?.board` exposes `create(actor, input, signal?)`,
`update(actor, input, signal?)`, full `list()` and immutable `snapshot()` to the host.
The snapshot contains `tasks`; each task has its own revision. There is no board
revision, persistence callback, hydration or durable peer-turn recovery.
`collaboration` can be an options object:

```ts
collaboration: {
  maxPeerTurnsPerPair: 8,
  // joinTimeoutMs defaults to the team's workerTimeoutMs (none unless configured).
  maxTasks: 128,
  maxTaskBytes: 16 * 1024,
  maxBoardBytes: 1024 * 1024,
}
```

Mutations and revision checks share a serialized queue. State is immutable and
cancellation is checked before commit. Limits include retained completed records
and serialized UTF-8 notes/results. This is local state, not a distributed lock.

Peer messages carry the original sender's name and structured provenance. Busy
members receive them at their next step; idle members start one scheduled turn.
Wakeups for `dependsOn`-held members queue until the host starts them; their
context is retained. Messages racing a final step still get consumed. Every
attempt reserves one lifetime credit for its unordered sender/recipient pair,
including busy steering and failed deliveries. Credits do not reset at idle or
per lead invocation. Exhaustion returns `TEAM_PEER_TURN_LIMIT`; publish findings
on the board. Host `team.team.sendMessage`/`followup` remain outside these caps.

A claimed task's ready-to-blocked transition notifies its claimant to pause;
blocked-to-ready notifies it to resume. Newly ready unclaimed tasks are offered
to idle non-lead members for pull-style claiming. Each member/task receives at
most one notice of each kind (`blocked`, `unblocked`, `available`) over the team's
lifetime, including busy steering. Reopen/complete or claim/release cycles do not
renew these credits. Later transitions remain visible through the board; the
lead or host must explicitly resume work when automatic credits are exhausted.
Lead notices add context; the join mechanism controls lead continuation.

The lead joins initial/preparing workers and later peer turns before its run
resolves. Waiting uses the same managed settlement barrier as delegation, with no polling timer or extra
model calls, capped by one hard `joinTimeoutMs` deadline per join. Each `onLeadEnd` re-arms this deadline; it is
not a total run cap. Use an invocation `signal` for a total wall-clock cap.
Only non-lead activity (attachment, peer delivery, member
board mutations or board-triggered member wakes) requires a new join notice.
A lead with no members answers without a synthetic join turn. All-idle unfinished
work is a valid blocker-report boundary; tasks are never automatically completed.
On deadline expiry, running members, dependency-held pending workers and in-flight
spawn preparation are cancelled together before dependencies can release more work.
Idle/settled members retain their roster entries, tools and outcomes while automatically releasing
active concurrency slots. User cancellation and
lead failure/exhaustion still stop managed work. The lead must report unfinished
work after a deadline. Closed sessions' captured tools are revoked before address
reuse. Models may stream tentative text before turn-end joining; terminal run
completion is the authoritative completion boundary. Host hook deadlines and
invocation cancellation remain independent bounds on a long-running join.
