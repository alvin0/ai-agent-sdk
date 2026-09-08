---
"@ai-agent-sdk/core": patch
---

A provider that repeats a tool-call id no longer kills the turn.

Two calls cannot share one id — a result pairs to exactly one — so the loop
rejected the whole round with `INVALID_TOOL_CALL` and ended the run. But the
FIRST call of that id is real work, and failing threw it away along with
everything the model had done to get there. Providers do emit repeated ids, and
losing a user's run over one is a worse answer than dropping the repeat.

- The repeat is dropped; the original runs. History keeps exactly one call per
  id, so the snapshot and the next request stay valid.
- The model is told which id it reused and that only the first call has a
  result, rather than silently receiving one result for two calls.
- A call with an invalid identity, name, or arguments still fails the round:
  that is a provider sending something unusable, not something recoverable.
