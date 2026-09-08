---
"@ai-agent-sdk/core": patch
---

`close_agent` now actually stops a worker, and closing one is no longer reported
to the lead as a failure.

Traced through a real conversation. The lead reached its workers with
`followup_task`, wrote its report, and closed all six. One of them kept calling
the model for another fourteen seconds, submitted its own self-check, and its
output became the last thing in the conversation — so the run appeared to end on
a subagent with nobody synthesizing, even though the lead had already answered.

- `closeWorker` cancelled only the run the HARNESS started, through its own
  `AbortController`. A worker running because of `followup_task` or any wake-up
  delivery belongs to the team's scheduler, which that controller does not
  reach, so the close left it running. It now cancels the team-scheduled work
  as well, and a cancellation that times out still frees the slot rather than
  wedging the close.
- Aborting a running worker rejects its run, and `followWorker` saw that
  rejection while the worker still looked like a running one — so it recorded
  `failed` and told the lead so. A close is not a failure: the runtime is
  marked as closing before anything is aborted, and neither the status nor the
  report is written for it. This also matters now that a worker's report can
  wake an idle lead, which would otherwise start a turn about a worker the lead
  had deliberately abandoned.
