---
"@ai-agent-sdk/core": minor
---

A managed lead is now told how to divide work, not just that it may.

Splitting an objective badly is not a mechanism failure, and no mechanism
catches it. A lead asked for "a todo app built by three agents" spawned a UI
worker, a logic worker and an auditor in one step, into an empty directory: the
auditor had nothing to review, and the other two each discovered the empty
directory separately and each decided to scaffold it, one announcing it would
write the very file the other had been given.

Neither Codex nor the DeepSeek harness offers the model a dependency field for
this; both state the discipline in prose. The generated lead instructions and
the `spawn_agent` description now do the same: plan and name the critical path
before delegating, keep the blocking next step local, give each worker a
disjoint set of files to write, and do not delegate review of something that
does not exist yet.

- `spawn_agent` takes `context: 'fresh' | 'fork'`. `fresh` starts a worker from
  its task alone; `fork` also gives it the lead's conversation so far, so it
  does not re-derive what the lead already established. The fork is cut at the
  last point where no tool call was outstanding — the lead is inside the turn
  that called `spawn_agent`, so copying its history verbatim would hand the
  worker a conversation ending in an unanswered call.
- `ManagedAgentTeamOptions.defaultSpawnContext` sets what a call that does not
  choose gets. It defaults to `'fresh'`, because a fork is paid for in input
  tokens on every round the worker runs; a host whose workers always operate on
  the lead's own workspace should set `'fork'`.
- `ManagedAgentWorker` gains `context`.
- `wait_agents` clamps a below-floor `timeoutMs` up to
  `AgentTeamOptions.minWaitTimeoutMs` (new, default 5 s, never above
  `waitTimeoutMs`) and reports the budget actually used as `waitedMs`. Asking
  for one second immediately after spawning returned the roster unchanged and
  cost a model round to learn nothing.
