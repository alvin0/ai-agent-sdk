---
"@ai-agent-sdk/core": patch
---

`runAgent` accepts a `spillStore`, so a single agent gets the same
oversized-output handling a session does.

Sessions could mount a spill store and hand the model `read_tool_output`; the
bounded loop could not, so the most common shape — one agent, no team — was the
only one where a result too large for the context was cut with no way back. The
option now flows through `runAgent` exactly as it does through a session, and
the retrieval tool is registered with it.
