---
"@ai-agent-sdk/core": patch
---

Two managed-team refusals now tell the model what to do instead of sending it
further into the mistake.

Both came out of one real run. A lead spawned four read-only researchers and
gave each `writes: ["/tmp/no-write"]` as a stand-in for "writes nothing"; the
scope check refused three of them for colliding over a file none of them would
ever write. Separately, a worker called `send_message` on its own name because
it read that tool as the way to report, and was refused for messaging itself.

Neither guard was wrong. What was wrong is that nothing pointed at the actual
fix: the refusal offered only `dependsOn` and narrowing, which sends a worker
that writes nothing looking for a better fake path, and the reporting worker was
never told that finishing is what reports.

- The `writes` schema and the lead instructions now say a worker that only reads
  declares nothing, and name the placeholder anti-pattern explicitly.
- The scope refusal adds "or omit writes entirely if this worker only reads".
- A generated worker is told its result reaches the lead when it finishes, so
  `send_message` is for passing context to a DIFFERENT worker, never itself.
- `send_message` says ANOTHER agent, and points at `list_agents` for the name.
