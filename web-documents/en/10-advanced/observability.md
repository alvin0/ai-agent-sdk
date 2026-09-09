# Observability

The SDK has one structured observation bus. It records model calls, physical
provider attempts, usage coverage, retries, credential/catalog operations, safe
errors, and correlated application logs — with `content: 'none'` as the default.

## Compose it

```ts
import { createObservability, MemoryObservationExporter } from '@alvin0/ai-agent-sdk-core/observability'

const exporter = new MemoryObservationExporter()  // test/local inspection only
const observation = createObservability({
  exporters: [{ exporter, requirement: 'best-effort', boundary: 'none' }],
})

const runtime = await createAgentRuntime({ providers, observability: { exporters: [...] } })

runtime.logger({ fields: { component: 'checkout-agent' } }).info('agent initialized')
```

## Three orthogonal knobs

**Delivery mode** — how hard the bus tries:

```ts
type DeliveryMode = 'operational' | 'reliable' | 'audit'
```

**Requirement** — whether a given exporter is allowed to fail:

```ts
requirement: 'required' | 'best-effort'
```

**Boundary** — what durability an exporter is honestly claiming:

```ts
type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'
```

Memory delivery never claims durability. `reliable` and `audit` modes require a
durable exporter package.

## The event envelope

Every event is versioned and JSON-safe:

```ts
interface ObservationEnvelope<TName extends string, TData> {
  schemaVersion: 1
  eventId: string          // deduplicates exporter retries
  sequence: number         // monotonic; a gap means a lost event
  name: TName
  occurredAt: string       // source time, not exporter receipt time
  severity: 'debug' | 'info' | 'warn' | 'error'
  priority: 'critical' | 'normal' | 'verbose'
  trace: { traceId: string; spanId: string; parentSpanId: string | null }
  resource: { sdkName: string; sdkVersion: string; serviceName?: string
              runtime?: 'edge' | 'browser' | 'node' | 'other' }
  correlation: CorrelationContext
  data: TData
}
```

`priority` controls sampling, buffering, and backpressure. **Critical events are
never sampled**, and every start has exactly one terminal event.

## Correlation ids have separate lifetimes

| Identifier | Lifetime |
| --- | --- |
| `traceId` | One distributed trace |
| `runId` | One agent invocation |
| `conversationId` | Multiple invocations in the same conversation |
| `turnId` | One user/agent turn |
| `modelCallId` | One **logical** model operation, including automatic retries |
| `attemptId` | One **physical** provider attempt |
| `toolCallId` | One requested tool execution |
| `providerRequestId` | Provider-assigned request id when available |
| `sessionId` | Host-defined product session |
| `sequence` | Ordered position inside one run ledger |

Do not overload `toolCallId` for model calls or HTTP attempts.

## Critical events

| Operation | Event name | Phases |
| --- | --- | --- |
| Agent run | `sdk.agent.run` | start/end |
| Agent turn | `sdk.agent.turn` | start/end |
| Model call | `sdk.model.call` | start/end |
| Provider attempt | `sdk.provider.attempt` | start/end |
| Retry scheduled | `sdk.provider.retry.scheduled` | point |
| Tool execution | `sdk.tool.call` | start/end |
| Compaction | `sdk.compaction` | start/end |
| Hook invocation | `sdk.hook.call` | start/end |
| User-input / approval wait | `sdk.user.input.wait` | start/end |
| Skill operation | `sdk.skill.operation` | start/end |
| Memory operation | `sdk.memory.operation` | start/end |
| Credential operation | `sdk.credential.operation` | start/end |
| Integration request (MCP, A2A, discovery) | `sdk.integration.request` | start/end |
| Export delivery | `sdk.observer.failure`, `sdk.exporter.state` | point |

Text, reasoning, and image deltas are **verbose** events. They are not required
for accounting and are disabled or sampled by default.

## Usage coverage — the honest accounting model

Numeric usage and *coverage* are separate concepts:

```ts
interface ModelCallUsageObservation {
  status: 'complete' | 'partial' | 'estimated' | 'missing' | 'not-applicable'
  source: 'provider' | 'estimator' | 'mixed' | 'none'
  values?: TokenUsage
  missingFields?: readonly TokenUsageField[]
  reason?: 'provider-omitted' | 'stream-aborted' | 'stream-failed' | 'invalid-usage'
}
```

Rules that matter in practice:

- one logical model call produces exactly one final usage observation;
- absence is `missing`, **never** an all-zero `TokenUsage`;
- `not-applicable` is used only when the SDK can prove no provider dispatch
  occurred;
- partial provider data stays partial rather than filling unknown fields with 0;
- estimated values are never presented as provider-reported or
  billing-authoritative;
- compaction and forced-final model calls count as model calls and appear in
  coverage;
- usage from failed/retried attempts is tracked separately, because a provider
  may bill an attempt without returning counters.

### The aggregate report

```ts
interface RunUsageReport {
  reported: Partial<TokenUsage>
  estimated?: Partial<TokenUsage>
  budgetTokens?: number
  coverage: {
    logicalCalls: number
    attempts: number
    complete: number
    partial: number
    estimated: number
    missing: number
    notApplicable: number
    possiblyBilledAttemptsWithoutUsage: number
  }
  authoritative: boolean
}
```

`reported` is a **lower-bound sum** when coverage is incomplete. Neither value may
be labelled "total cost" or "total tokens" unless coverage is `authoritative`.

Each physical attempt records `dispatchState: 'not-sent' | 'sent' | 'unknown'`.
An interrupted call in `sent` or `unknown` state that returned no usage
increments `possiblyBilledAttemptsWithoutUsage` — the honest answer when exact
billing is unknowable from the response.

### Budget contributions and partial attempts

`budgetTokens` is an optional budget projection, not an invoice total. The SDK
combines reported buckets with missing-bucket estimates within each logical call,
then sums those contributions. A reported bucket from one call cannot hide an
estimate from another. Known attempt contributions are retained when aggregate
counters cannot represent them; call and attempt totals are not added twice.
Missing usage is still unknown, not zero, and estimates remain non-authoritative.

An aggregate omits `totalTokens` when contributing reports do not share total
coverage. It does not manufacture an exact total from partial buckets at the
next aggregation layer. Original attempt reports retain the underlying evidence;
cross-scope counters that fail validation are omitted from the summary.

Cancellation ends a public wait, not necessarily external work. HTTP transport
retains cleanup ownership of late custom-fetch responses and bounds unread-body
cleanup to 30 seconds. Active SSE piping receives the abort signal. A custom
cancel callback that ignores cancellation still cannot be forcibly stopped.

### When usage is missing

Mandatory usage stops also apply to auto-compaction: a summary that produces
`usageRequired` or `usageUnavailable` stops the invocation before any next main,
summary, retry or finalizer request. Maintenance fail-open does not clear this
decision; raw summary evidence stays in the report.

`runtimeLimits.maxTotalTokens` covers normal rounds (including retries and
finalizers), not compaction. Summary calls instead use `maxSummaryTokens`,
`summaryTimeoutMs`, `compactionRetries` and `maxOverflowRetries` under `compaction`.
There is no separate cumulative summary-token cap. Run reports include both,
so their total can exceed the normal-turn cap; it is not a billing ceiling.

`usagePolicy.estimateTimeoutMs` bounds an asynchronous estimator independently of
`modelTimeoutMs` (default: 30,000ms; positive integer up to 2,147,483,647).
The callback receives `input.signal`, aborted on caller cancellation, ledger
closure, or this deadline. The SDK retains raw provider/attempt evidence before
invoking it. Timeout, rejection, or invalid counters stop admission with
`USAGE_REQUIRED`; unknown usage never becomes zero. Late results cannot change
the sealed report. A synchronous callback that blocks the JavaScript thread
cannot be preempted; estimators must cooperate and must not perform busy loops.

All model continuations—including retry hooks, structured finalizers and
`onTurnEnd` continuations—respect the known token cap and required-usage policy.
Finalizers may receive an extra step, but no extra token budget. An in-flight
request can exceed the cap; the cap blocks subsequent work, not tokens already
generated by the provider.

A total-token guard cannot enforce an exact limit if a provider omits usage, so
the run policy makes that explicit:

| Policy | Behaviour |
| --- | --- |
| `warn` (default) | Continue, emit a critical missing-usage diagnostic. |
| `estimate` | Enforce the budget with a configured estimator, labelled estimated. |
| `fail` | Stop before the next model call — the accounting contract was not met. |

## Privacy is the default

Excluded unless explicitly enabled: OAuth tokens, API keys, cookies, account
details, headers outside a positive allowlist, and prompt/completion content.

The exact provider-wire logger is a **separate high-risk diagnostic bridge**
because its body contains prompts and tool results:

```ts
import { createDailyJsonlRequestLogger } from '@alvin0/ai-agent-sdk-observability-node/diagnostic'

registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({
    content: 'full',
    allowWireBodies: true,   // both flags required, or construction refuses
  }),
}))
```

Requests append to a private unique file under `.providers/<provider>/wire/`.
Credentials, cookies, and account ids are redacted; **request bodies are not**,
because prompts and tool results are the point of this diagnostic. `.providers/`
is git-ignored but should still be treated as sensitive local data.

## Exporter packages

| Package | Boundary | Use for |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-observability-fetch` | `remote-acknowledged` | Universal acknowledged HTTPS batches |
| `@alvin0/ai-agent-sdk-observability-node` | `local-durable` | Checksum-framed JSONL journal |
| `@alvin0/ai-agent-sdk-observability-browser` | `local-durable` | IndexedDB staging and crash recovery |
| `@alvin0/ai-agent-sdk-observability-otel` | — (processor) | Map events to caller-supplied OpenTelemetry APIs |

---

# Configuration

## Where it goes

```ts
const runtime = await createAgentRuntime({
  providers,
  resource: { serviceName: 'checkout-api', runtime: 'node' },
  observability: {
    mode: 'reliable',
    content: 'none',
    minimumLogLevel: 'info',
    exporters: [ /* registrations */ ],
    processors: [ /* ObservationProcessor */ ],
    redactors: [ /* ContentRedactor */ ],
    includeErrorStacks: false,
    openSpan: bridge.openSpan,
    maxQueueEvents: 10_000,
    maxQueueBytes: 8 * 1024 * 1024,
    maxBatchEvents: 256,
    maxBatchBytes: 512 * 1024,
    flushTimeoutMs: 10_000,
    shutdownTimeoutMs: 15_000,
  },
})
```

## Delivery mode

```ts
type DeliveryMode = 'operational' | 'reliable' | 'audit'
```

| Mode | Meaning |
| --- | --- |
| `operational` | Best-effort telemetry. Drops under pressure are recorded, not fatal. |
| `reliable` | Requires a durable exporter. Delivery gaps are surfaced. |
| `audit` | Strictest. Every critical event must reach a durable boundary. |

`reliable` and `audit` require a durable exporter package. Memory delivery
**never** claims durability.

## Exporter registration

Each registration states three independent things:

```ts
{
  exporter: jsonlObservationExporter({ rootDir: './observations' }),
  ownership: 'owned',            // 'owned' | 'borrowed'
  requirement: 'required',       // 'required' | 'best-effort'
  boundary: 'local-durable',     // 'none' | 'local-durable' | 'remote-acknowledged'
}
```

| Field | Question it answers |
| --- | --- |
| `ownership` | Does the runtime close it after active runs settle? |
| `requirement` | Is an export failure allowed? |
| `boundary` | What durability is this exporter honestly claiming? |

An `owned` exporter is closed by the runtime after all active runs settle. A
`borrowed` one is yours to close.

## Picking an exporter

| Deployment | Package | Registration |
| --- | --- | --- |
| Edge/Worker | `observability-fetch` | `boundary: 'remote-acknowledged'` |
| Browser | `observability-browser` | `boundary: 'local-durable'` |
| Node | `observability-node` | `boundary: 'local-durable'` |
| Any + OpenTelemetry | `observability-otel` | `openSpan` + `processors`, not an exporter |

You can register several. A typical Node service uses a local JSONL journal as
`required`/`local-durable` and an HTTPS exporter as `best-effort`/
`remote-acknowledged`.

## Edge flushing

An Edge host cannot rely on process exit. Hand the flush promise to the
platform's explicit `waitUntil`:

```ts
import { flushObservabilityWithWaitUntil } from '@alvin0/ai-agent-sdk-observability-fetch'

export default {
  async fetch(request, env, ctx) {
    const response = await handle(request)
    flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
    return response
  },
}
```

The package never assumes a platform global.

## Browser lifecycle

```ts
import { installBrowserObservabilityLifecycle } from '@alvin0/ai-agent-sdk-observability-browser'

installBrowserObservabilityLifecycle(observability)
```

Opt-in. It flushes on hidden visibility and `pagehide`, and makes **no
unload-durability claim**. Stored events remain unacknowledged until you call
`acknowledgeBatch()` after your own remote sink confirms delivery.

## OpenTelemetry

```ts
const bridge = createOpenTelemetryBridge({
  tracer: tracerProvider.getTracer('my-agent'),
  meter: meterProvider.getMeter('my-agent'),
  logger: loggerProvider.getLogger('my-agent'),   // optional
})

const observation = createObservability({
  openSpan: bridge.openSpan,
  processors: [bridge.processor],
})
```

The bridge is **not an exporter**. It installs no global provider, owns no OTLP
exporter, performs no network I/O, and never claims telemetry delivery. Configure
a journal or an acknowledged exporter separately when you need delivery
guarantees.

Your application keeps ownership of provider registration, processors,
exporters, flushing, and shutdown.

## Sampling

`priority` on the event envelope controls sampling, buffering, and backpressure:

| Priority | Sampling |
| --- | --- |
| `critical` | **Never sampled.** Every start has exactly one terminal event. |
| `normal` | Sampled according to policy. |
| `verbose` | Text/reasoning/image deltas. Disabled or sampled by default. |

## Health

```ts
const report = await runtime.close()
report.observationHealth   // retained/evicted event and byte counts

runtime.diagnostics()      // bounded in-memory diagnostic ring
```

Observability observes itself: `sdk.observer.failure` and `sdk.exporter.state`
record failures, drops, recovery, and queue state.

## Read next

- [Security](/en/10-advanced/security) — privacy policy in context
- [Observability API reference](/en/13-api-reference/observability)
- [Browser crash recovery](/en/10-advanced/deploy-browser)
