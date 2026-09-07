---
"@ai-agent-sdk/core": major
---

Subagents now run concurrently with their lead.

`spawn_agent` no longer waits for the worker it creates. It starts the worker and
returns, so a lead keeps working, can read its workers' messages, and can spawn
more — none of which was possible while it sat parked inside its own tool call.

A worker's answer reaches the lead three ways instead of as the tool's return
value: a quiet completion message injected into the lead's history, an `outcome`
recorded on the roster and returned by `list_agents`, and `wait_agents`.

- `wait_agents` takes `timeoutMs` (default 30 s, or `AgentTeamOptions.waitTimeoutMs`)
  and returns `{ agents, settled, timedOut }` instead of a bare roster array. It
  returns as soon as the FIRST target settles. A timeout is a normal result: an
  unbounded wait leaves a coordinator unable to tell a slow agent from a stuck one.
- `close_agent` is new. A finished worker keeps its `maxWorkers` slot until closed.
- `ManagedAgentTeam.spawn()` resolves to the running `ManagedAgentWorker` rather
  than its finished result. Use the new `awaitWorker()`, `closeWorker()`, and
  `dispose()`; hosts **must** call `dispose()`, because a worker deliberately
  outlives the run that started it.
- A member attached with `tools: 'reporting'` receives `list_agents` and
  `send_message` only. Generated workers are attached that way: the verbs that
  block or delegate remove the stopping point an agent created for one bounded
  task needs.
- The lead's turn is held open while a worker of its is unfinished, so the lead
  still owns the ending. An aborted or exhausted turn ends regardless.
- `AgentTeamMember` gains an optional `outcome`.
