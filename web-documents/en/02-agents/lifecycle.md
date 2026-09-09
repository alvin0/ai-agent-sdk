# Lifecycle

Four lifetimes, each with an explicit start and an explicit end.

```text
createAgentRuntime()  ──── providers ready ──── runs ──── close() ──── RuntimeCloseReport
      │
      runtime.agent()  ──── frozen binding, no I/O ────────────────────── (nothing to close)
            │
            createSession()  ── history + memory + skills ── reset() / drop
                  │
                  run() / stream()  ── turn hooks ── terminal event ── RuntimeRunReport
```

## Runtime startup

```ts
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  signal: bootController.signal,
})
```

`createAgentRuntime()` is async because provider plugins have a `ready()`
lifecycle boundary. That is where a capability actually acquires resources — for
example `jsonlObservationExporter()` is **inert** when constructed and only
touches the filesystem when the runtime calls `ready()`.

Provider registration is **transactional**: route claims are declared up front,
so a conflict fails *before setup completes* rather than at first use. A failed
startup rolls back every partial registration.

## Agent binding has no lifecycle

`runtime.agent({ … })` performs no I/O and holds no resource. It is a frozen
binding. There is nothing to close, and no `ready()` step.

The same is true of `defineAgent()` — a definition is validated, normalized, and
frozen at module scope.

## Session lifetime

A session owns mutable state: history, memory, activated skills, and a
per-session exclusion lock.

```ts
session.isRunning              // is a turn in flight?
await session.whenIdle(signal) // wait for it to settle
session.reset()                // fresh conversation id, same agent/tools
```

A session **prevents overlapping runs** on the same conversation.
`session.compact()` takes the same exclusion lock as a model turn, so compaction
and normal execution cannot rewrite one history concurrently.

`session.reset()` intentionally starts a fresh conversation id and clears
conversation-scoped skill activation, while restoring definition-level memory
seeds.

A session has no `close()`. To persist it, take a snapshot; to discard it, drop
the reference.

## Turn hooks

```ts
const session = agent.createSession({
  hooks: {
    beforeStep: ctx => ({ kind: 'proceed' }),
    onRequestError: ctx => 'retry',
    checkpoint: async ctx => { await store.save(ctx) },
    onTurnEnd: async ctx => { metrics.record(ctx) },
  },
})
```

| Hook | Signature | Purpose |
| --- | --- | --- |
| `beforeStep` | `(ctx) => StepDecision` | Gate or augment the next model step |
| `onRequestError` | `(ctx) => 'retry' \| 'fail'` | Decide recovery for a model request failure |
| `checkpoint` | `(ctx) => void` | Durability point — persist progress |
| `onTurnEnd` | `(ctx) => void` | Terminal accounting for one turn |

### `beforeStep` returns a decision

```ts
type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

`proceed` optionally prepends messages to that one request — useful for
injecting fresh state the model must see now. `reject` stops the step with a
reason, which is how you express **conditional execution** without a workflow
engine. See [Conditional Execution](/en/06-workflows/conditional-execution).

Hook invocations are observed as `sdk.hook.call` events with a closed hook kind
and a safe error only, and are bounded by their own time limits.

## Run reports

Every run produces a terminal record:

```ts
const response = await agent.generate(input)

response.report.usage        // reported + estimated, kept separate
response.report.coverage     // logical calls, physical attempts, missing counts
response.report.authoritative // may this be called a total?
response.report.errors       // correlated, sanitized error records
```

`reported` is a **lower-bound sum** when coverage is incomplete. Neither value
may be labelled "total cost" or "total tokens" unless `authoritative` is true.

## Closing the runtime

```ts
const report = await runtime.close({ signal })

report.state                 // 'closed'
report.quiescenceEnd         // 'settled' | 'timeout' | 'caller-abort'
report.deadlineReached
report.activeRunsAtClose
report.abortedRuns
report.unsettledRuns         // > 0 means something ignored cancellation
report.operations            // per-operation close summaries
report.components            // per-component close reports
report.observationHealth     // retained/evicted event and byte counts
```

Close admission is **atomic**, cancellation is **composed**, late generations are
**sealed**, per-kind close evidence is **deterministic**, one shared close task is
safe against caller abort, and loggers become no-ops after close.

Treat `unsettledRuns > 0` as a defect, not noise.

## Closing what you connected

The runtime closes what it **owns**. It never closes a borrowed resource, and
never invents a close action for something it did not acquire.

```ts
try {
  await runtime.close()          // quiesce runs first
} finally {
  await mcp?.closeWithReport()   // then close what you connected
}
```

| Lifecycle label | Who closes it |
| --- | --- |
| `inert-value` | Nobody — no resource acquired |
| `inert-runtime-owned-registration` | The runtime removes the registration |
| `connected-caller-owned` | You, **after** closing the runtime |
| `borrowed-caller-owned` | You; the runtime only uses it |
| `host-owned` | You, and you read the returned report |
| `explicit-owned-or-borrowed` | Stated at registration time |

An **owned** observation exporter is closed by the runtime after all active runs
settle. A **borrowed** one is yours.

## Operation leases

The runtime holds one operation-lease registry covering agent runs, catalog
refresh, manual compaction, and team work. That is what lets `close()` report
`activeRunsAtClose` and `unsettledRuns` truthfully instead of guessing, and what
seals late generations so a run started during shutdown cannot slip through.

## Read next

- [Production Deployment](/en/10-advanced/production-deployment) — shutdown in Edge, browser, and Node
- [Conditional Execution](/en/06-workflows/conditional-execution) — `beforeStep` in practice
- [Observability](/en/10-advanced/observability) — the events every phase emits
