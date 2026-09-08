---
"@ai-agent-sdk/core": patch
---

A worker whose model call failed is now reported as failed, not as finished
with nothing to say.

`runPending` resolves even when the turn ended on an error: the response carries
an error reason and an empty answer. The harness read any resolution as success,
so a researcher that died on an unreachable source was announced to the lead as
`Worker 'realestate_infra' finished:` — with nothing after the colon. The lead
was told the sector was covered by a worker that never got an answer out of the
model, which is worse than being told nothing at all. Codex's own notifications
carry the agent's completed STATUS, and the DeepSeek harness records a blocker
code; both distinguish a failure from a result.

A run that ends on an error reason, on the output limit, on missing usage under
a mandatory policy, or with an empty answer is now recorded as `failed` with
that reason, reported to the lead as a failure, and visible as such in
`workers()` and on the roster.

A worker that ran past its own `workerTimeoutMs` now says so: "it ran past its
Nms deadline without finishing. Narrow the task, or split it, before delegating
it again". The raw abort read "The operation was aborted due to timeout", which
tells the lead neither whose timeout it was nor whether re-delegating would
help.
