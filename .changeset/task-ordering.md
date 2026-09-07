---
"@ai-agent-sdk/core": major
---

A managed lead can now divide work, not just agents: ordering, file ownership,
and declared roles are enforced by the harness.

Prose alone was not enough. A lead told to plan first still spawned a UI worker,
a logic worker and an auditor into an empty directory in one step — the auditor
had nothing to review, and the other two were both given the same page component
to write. These are the mechanisms that make a bad division fail loudly, or not
matter at all.

- `spawn_agent` takes `dependsOn: string[]`. The worker is created immediately
  and **held** until every named worker settles, then started and handed what
  they produced. So a lead can spawn the whole plan in one step — which is what
  it wants to do — and the order still holds. Dependents are released on
  settlement, not on success: waiting only for success lets one failed worker
  strand every step planned after it. A dependency can only name an existing
  worker, so the graph cannot contain a cycle by construction.
- `spawn_agent` takes `writes: string[]`, the files and directories a worker may
  write. A spawn whose scopes overlap a worker that could run at the same time
  is **refused**, and the error names the fix — depend on that worker, or narrow
  the scope. Scopes compare by path component, so `app` covers `app/page.tsx`. A
  worker this one already depends on is not a conflict.
  `ManagedAgentTeamOptions.writeScopePolicy` (`'reject'` by default, or
  `'warn'` / `'off'`) changes this; a warning is recorded on
  `ManagedAgentWorker.warnings`.
- `ManagedAgentTeamOptions.roles` declares the worker kinds a lead may choose
  from, each with a `description`, an optional `whenToUse`, and optional
  `instructions` given to the worker. Declaring any turns `spawn_agent`'s free
  text `specialty` into a `role` enum whose schema carries each role's purpose
  and precondition — the one place the lead reads while choosing.
- `ManagedAgentWorkerStatus` gains `'pending'`, and `ManagedAgentWorker` gains
  `dependsOn`, `writes`, `role`, and `warnings`.
- **Breaking:** `AgentTeamMember.status` gains `'pending'`, and a held member is
  reported that way. `AgentTeam.markPending(name, until)` is how a host declares
  it. This is not cosmetic: a session that has never run is idle and not
  running, indistinguishable from one that has finished, so `wait_agents` on a
  held member used to be answered at once and its coordinator concluded the work
  was done. `whenIdle` now waits for the member to be released first. Hosts that
  switch on the status union must handle the new member.
