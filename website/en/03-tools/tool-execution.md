# Tool Execution

## The dispatch pipeline

```text
model emits tool calls (one batch)
      │
      ▼  classify        isConcurrencySafe(args) → parallel | exclusive
      ▼  approve         approval broker, if configured
      ▼  intercept       interceptors wrap the call
      ▼  parse           untrusted → typed  (throw → INVALID_ARGUMENTS)
      ▼  execute         with ctx.signal and a timeoutMs deadline
      ▼  render / meta   model-facing blocks + UI metadata
      ▼  commit          the whole batch commits together
      │
      └── concludeTurn()? → turn ends AFTER the batch commits
```

Calls are **staged in batches**. The loop commits every call in the current batch
before acting on `concludeTurn()`, so a parallel sibling's work is never
discarded.

## Concurrency is fail-closed

```ts
isConcurrencySafe: args => args.mode === 'read'
```

Only an exact `true` opts a call into parallel scheduling. A throwing or absent
classifier means **exclusive**.

Both reference implementations default to exclusive and require an explicit
opt-in, because the failure mode of guessing wrong is **silent data corruption**
from two tools mutating the same state — not a visible error.

Return `true` only when the call cannot observe or mutate state another
concurrent call touches. A pure read of an immutable source qualifies; "probably
fine" does not.

| Tool | Safe? |
| --- | --- |
| Read an immutable file revision | ✓ |
| Query a read replica | ✓ |
| Pure computation | ✓ |
| Write a file | ✗ |
| Run a shell command | ✗ |
| Anything sharing a cursor, cache, or temp path | ✗ |

`maxParallel` bounds how many safe calls actually run at once.

## Timeouts are cooperative

```ts
timeoutMs: 30_000,
execute: async (args, ctx) => fetch(url, { signal: ctx.signal }),
```

`timeoutMs` is a wall-clock bound for one call and is **never sent to the model**.

Declaring it is a **promise** that `execute` forwards `ctx.signal`: the pipeline
aborts the signal and **waits**. It does not abandon the promise, because an
orphaned tool would keep mutating state behind the loop's back.

If a tool ignores the signal, teardown waits up to `toolTeardownTimeoutMs` and
then reports `MODEL_TEARDOWN_TIMEOUT` — and the runtime close report shows
`unsettledRuns > 0`. That is an adapter/tool defect, not a transient failure.

## Barriers

Generated skill tools are **scheduler barriers**. This preserves model order for
a batch such as `load_skill` followed by `read_skill_resource`, and does not
assume a remote provider is safe for concurrent access.

Use the same idea for your own tools: return `false` from `isConcurrencySafe`
when ordering matters, rather than trying to coordinate inside `execute`.

## Interceptors

```ts
const session = agent.createSession({
  interceptors: [async (call, next) => {
    const started = performance.now()
    try {
      return await next(call)
    } finally {
      metrics.record(call.name, performance.now() - started)
    }
  }],
})
```

Interceptors wrap dispatch — auditing, metrics, redaction, per-tenant policy.
They are captured with their **original receivers**, so a method taken off an
object keeps its `this` and its live operational state.

## Tool sources

A `ToolSource` publishes a whole catalog at once. An MCP server is the canonical
example.

```ts
const agent = runtime.agent({ id: 'a', model, instructions: '…', toolSources: [mcp] })
```

Snapshots are **synchronous and atomic**: one revision binds both schema and
execution. A catalog that changes mid-run therefore cannot make the model call a
tool whose schema it never saw. Terminal evidence carries source and revision
only.

Lifecycle is `connected-caller-owned`:

```ts
try {
  await runtime.close()          // quiesce runs first
} finally {
  await mcp.closeWithReport()    // then close what you connected
}
```

## Result bounds

| Bound | Effect |
| --- | --- |
| `maxToolResultBytes` | Serialized bytes retained for one finalized result |
| `maxToolDurationMs` | End-to-end allowance for one call |
| `toolTeardownTimeoutMs` | Wait after cancelling an uncooperative tool |
| `maxToolCalls` | Dispatched tools per run (64 by default) |
| `maxConsecutiveToolErrors` | Consecutive failures before cutoff |

Oversized tool-result text is pruned to a durable head/tail projection before
summarization during compaction, so a huge result degrades gracefully instead of
blowing the context window.

## Every call is observed

`sdk.tool.call` records start/end for each dispatch, plus approval wait and
decision when applicable. Events carry `traceId`, `spanId`, and `parentSpanId`;
parallel calls to the same tool always receive **distinct span ids**, while the
tool call id stays the correlation id.

## Read next

- [Error Handling](/en/03-tools/error-handling)
- [Permissions](/en/03-tools/permissions)
- [Parallel Execution](/en/06-workflows/parallel-execution)
