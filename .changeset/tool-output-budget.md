---
"@ai-agent-sdk/core": minor
---

A tool result can no longer spend the context window on its own, and a host
picks how oversized output is handled.

`maxToolResultBytes` was the only bound on what a tool put in front of the
model, and it is a storage bound: 4 MiB passes easily and still spends a whole
window. Once it is spent the provider rejects the next request and every tool
result already paid for is lost. Both reference harnesses stop this at the
result boundary rather than when the request is assembled, and they differ only
in where the removed text goes — so both shapes are offered.

- **`TurnBounds.maxToolResultTokens`**, default **10,000** — the same allowance
  Codex gives a shell call. Applied when the result is produced, before it ever
  reaches history.
- **`TurnBounds.toolResultOverflow`**, default **`auto`**:
  - `truncate` — Codex's shape. Keep both ends, drop the middle, tell the model
    how much went and that re-running more narrowly is how to get it. Needs no
    storage, works in any runtime.
  - `spill` — the DeepSeek harness's shape. Save the full text through a
    mounted `SpillStore`, show a bounded preview plus a locator, and give the
    model `read_tool_output` to read or search the rest. Nothing is lost.
  - `auto` — spill when a store is mounted, truncate when none is. The cheap
    path works with no configuration; the lossless one turns itself on the
    moment a host mounts a store. `spill` with no store, or a store that
    throws, also falls back to truncating: losing a result entirely is a worse
    answer to a full disk than showing most of it.
- **`SpillStore`** is a three-method port (`save`, `read`, `search`) on the
  session and on runtime sessions. `createMemorySpillStore()` ships with the
  SDK — universal, bounded, in-process, enough to get the text out of the
  model's context. A host needing durability implements the port over its own
  filesystem or object storage; core is a universal package and cannot open a
  file.
- **`read_tool_output`** is registered automatically wherever a store is
  mounted, and is `budgetExempt`: a model that cannot reach its own spilled
  output is worse off than one whose output was simply cut.
- **`ToolDefinition.maxOutputTokens`** lets a tool declare its own share. The
  stricter of it and the turn budget wins — the same way Codex resolves a
  model-requested `max_output_tokens` against its deployment policy — so a file
  reader can ask for room a status check has no use for without any tool
  exceeding what the host allows.

Only text is shortened, and in place: an image block passes through untouched,
and the result's `value` is never rewritten, so a host's log still records what
the tool actually returned.
