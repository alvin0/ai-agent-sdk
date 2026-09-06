# Tool Error Handling

A tool failure is **not** an application exception. It becomes a result the model
sees and can react to.

## The two result shapes

```ts
type ToolExecutionResult = ToolSuccess | ToolFailure
```

| Field | `ToolSuccess` | `ToolFailure` |
| --- | --- | --- |
| `isError` | `false` | `true` |
| `value` | raw returned value | — |
| `error` | — | `{ message, code }` |
| `content` | what the model reads | the failure, phrased for the model |
| `meta` | UI metadata | UI metadata |
| `additionalContext` | from `ctx.addContext()` | from `ctx.addContext()` |
| `concludesTurn` | `true` if requested | typed **`never`** |

## A failure can never end the turn

`concludesTurn` is typed `never` on `ToolFailure` **by design**. Otherwise a
denied or crashed tool could silently stop the work the user asked for — the
opposite of what a failure should do.

## Failure statuses

The `tool-result` run event carries a status:

| Status | Cause | Model sees |
| --- | --- | --- |
| `completed` | `execute` returned | The rendered value |
| `failed` | `execute` threw | The failure, phrased for the model |
| `rejected` | Policy, catalog, arguments, or budget rejected the call | A rejection it can react to |
| `aborted` | The run was cancelled before or during the call | An abort notice |

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'tool-result' && event.status !== 'completed') {
    renderToolFailure(event.callId, event.status, event.output)
  }
}
```

## Argument failures are model-correctable

Throwing inside `parse` produces `INVALID_ARGUMENTS`. The model reads your
message and retries with corrected arguments.

```ts
parse: raw => {
  const parsed = Args.safeParse(raw)
  if (!parsed.success) throw new TypeError(`limit must be 1–100; got ${(raw as any)?.limit}`)
  return parsed.data
},
```

Write the message for the **model**, not for your logs: state the constraint and
what was received.

## Body failures

An `execute` throw becomes `ToolFailure`. What the model reads is the failure
phrased for it — not a stack trace.

```ts
execute: async ({ path }, ctx) => {
  const resolved = resolveInsideProject(path)
  if (resolved === null) {
    // Deliberate, actionable failure.
    throw new Error(`path must stay inside the project; got ${path}`)
  }
  return { text: await readFile(resolved, { encoding: 'utf8', signal: ctx.signal }) }
}
```

Two things to keep out of a thrown message: credentials and raw upstream error
text. Sanitize before throwing — the message reaches the model and your
transcripts.

## Distinguish "expected" from "broken"

Not every unhappy path deserves a throw. A tool that returns a typed "not found"
gives the model more to work with than an error does:

```ts
// Better: the model can branch on this.
execute: async ({ id }) => {
  const row = await db.find(id)
  return row === null ? { found: false } : { found: true, row }
}
```

Reserve throws for **contract violations** — invalid arguments, denied scope,
unreachable dependency — and return values for **domain outcomes**.

## Bounds that stop a failure loop

| Bound | Behaviour |
| --- | --- |
| `maxConsecutiveToolErrors` | Cuts off after N consecutive failures |
| `repeatToolWarningAt` / `repeatToolLimit` | Warns, then stops exact repeats |
| `toolCycleWarningAt` / `toolCycleLimit` / `maxToolCycleLength` | Detects short multi-step cycles |
| `maxToolCalls` | 64 dispatched tools per run |

So a model that cannot satisfy your tool fails loudly rather than looping until
the token ceiling. When you hit these, the schema or the description is usually
the real defect.

## Timeout and teardown

A tool that declares `timeoutMs` is asserting it forwards `ctx.signal`. On
timeout the pipeline aborts the signal and **waits** up to
`toolTeardownTimeoutMs`.

If the tool ignores cancellation you get `MODEL_TEARDOWN_TIMEOUT` and
`unsettledRuns > 0` in the runtime close report. Treat that as a defect in the
tool, not a transient failure.

## Observer failures are contained

Interceptors, hooks, and `onEvent` observers are bounded by
`observerTimeoutMs`, and their failures **never change run behaviour**. The same
is true of a skill provider's `onIo` observer. Instrumentation cannot break
execution.

## What reaches your logs

Errors are recorded as correlated, sanitized `SafeErrorRecord` entries on the run
report:

```ts
const response = await agent.generate(input)
for (const error of response.report.errors) {
  console.error(error.code, error.message)   // no credentials, no raw provider text
}
```

`SupportSafeError` is the projection to use in support tickets and
cross-service propagation.

## Read next

- [Permissions](/en/03-tools/permissions) — the `rejected` path
- [Advanced Error Handling](/en/10-advanced/error-handling) — the SDK-wide taxonomy
