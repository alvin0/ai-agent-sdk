# Observability and Usage Implementation Design

Status: historical; superseded by `core-capability-composition-design.md`

Migration note (2026-09-02): this document describes the current split-package
implementation. For the Core + Capability target, ownership moves into core and
the exporter batch adds atomic delivery-free `runRecords[]` as specified by
[`core-capability-composition-design.md`](./core-capability-composition-design.md).
The current events-only batch remains baseline evidence, not the target API.

Architecture rationale: [observability-and-usage-architecture.md](./observability-and-usage-architecture.md)  
Package design: [monorepo-implementation-design.md](./monorepo-implementation-design.md)  
Executable evidence: [implementation-spike-evidence.md](./implementation-spike-evidence.md)

## 1. Outcomes and non-negotiable invariants

The implementation produces four connected but non-interchangeable outputs:

1. a canonical per-call and per-run accounting ledger;
2. traces for operation topology and latency;
3. structured, correlated logs for diagnosis;
4. bounded-cardinality metrics for monitoring.

The ledger is the accounting source. Traces, logs, and metrics are projections and may be sampled or exported differently. A log line does not prove an operation started or ended.

The following invariants are normative:

- Every instrumented operation that starts has exactly one terminal state: `success`, `error`, `aborted`, `rejected`, or `unknown`.
- Every logical model call ends with usage coverage `complete`, `partial`, `estimated`, `missing`, or `not-applicable`.
- A numeric zero is never used to represent missing usage.
- `not-applicable` is legal only when code proves no provider dispatch was invoked.
- A logical model-call span contains automatic retries; each physical HTTP dispatch is a child attempt span.
- Every public error after run creation carries a stable error code, `traceId`, and `runId`; the terminal report remains retrievable.
- Observation failure does not rewrite a successful model/tool result in operational or reliable mode. Audit mode fails closed at its durability boundaries: before dispatch it prevents the request; after dispatch it surfaces a delivery error without retrying or hiding the provider outcome in the report.
- Redaction and size bounding happen before exporter fan-out.
- Critical lifecycle events are never sampled. Resource exhaustion may still reject an event; rejection is counted and surfaced in health rather than hidden.
- Export is at-least-once unless the destination deduplicates by `batchId`/`eventId`. The SDK never claims network-level exactly-once delivery.

## 2. Ownership and dependency injection

`@ai-agent-sdk/core` owns only stable contracts and per-model-call primitives:

- event envelope and correlation types;
- observation port and delivery-mode types;
- trace/run/span contracts, Web Crypto fallback IDs, and W3C `traceparent` rendering;
- usage counters, attempt report, logical call report;
- model registry instrumentation and provider-plugin context.

`@ai-agent-sdk/agent` owns:

- run/turn/tool/compaction instrumentation;
- the canonical in-memory run ledger;
- run aggregation, terminal `RunReport`, and usage policy;
- public run handles whose report survives event-stream cancellation.

`@ai-agent-sdk/observability` depends on core and owns the concrete bus, processors, scoped logger, in-memory/test exporters, trace/log/metric projections, health accounting, flush, and shutdown.

Runtime exporters stay separate:

- `observability-fetch`: acknowledged HTTP batches and Edge `waitUntil` integration;
- `observability-browser`: IndexedDB queue and page lifecycle integration;
- `observability-node`: durable JSONL journal and Node lifecycle helpers;
- `observability-otel`: mapping to caller-supplied OpenTelemetry API objects; it does not own an OTLP network exporter.

Runtime packages accept an `ObservationPort` through constructors/options. They do not import the concrete bus. If no port is supplied, the ledger still works and the core uses a no-op port whose health state is explicitly `disabled`.

The no-op port reports mode `operational`, capture status `disabled`, and a delivery summary with `requiredBoundary: 'none'`, `reachedBoundary: 'none'`, and `complete: true` because the host requested no external delivery. `complete` therefore means “all configured requirements were met,” not “telemetry was exported.” Health remains `disabled`, so callers can distinguish the two.

## 3. Core contracts

The following TypeScript shapes are normative. Implementations may split them across files but must preserve names and semantics.

```ts
export type DeliveryMode = 'operational' | 'reliable' | 'audit'
export type ObservationPriority = 'critical' | 'normal' | 'verbose'
export type ObservationPhase = 'start' | 'end' | 'point'
export type OperationStatus = 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'

export interface ObservationResource {
  readonly sdkName: 'ai-agent-sdk'
  readonly sdkVersion: string
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly runtime: 'browser' | 'edge' | 'node' | 'unknown'
}

export interface CorrelationContext {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly runId: string
  readonly conversationId?: string
  readonly turnId?: string
  readonly modelCallId?: string
  readonly attemptId?: string
  readonly toolCallId?: string
  readonly providerRequestId?: string
  readonly sessionId?: string
}

export interface ObservationEvent<
  Name extends ObservationEventName = ObservationEventName,
  Data extends JsonObject = JsonObject,
> {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly name: Name
  readonly phase: ObservationPhase
  readonly occurredAt: string
  readonly monotonicMs: number
  readonly priority: ObservationPriority
  readonly resource: ObservationResource
  readonly correlation: CorrelationContext
  readonly data: Data
}

export interface CaptureReceipt {
  readonly eventId: string
  readonly status: 'accepted' | 'rejected' | 'disabled'
  readonly durable: boolean
  readonly boundary: 'none' | 'local-durable' | 'remote-acknowledged'
  readonly reason?: 'capacity' | 'closed' | 'processor-failed' | 'exporter-unavailable'
}

export interface ObservationPort {
  readonly mode: DeliveryMode
  openSpan(input: OpenObservationSpanInput): ObservationSpan
  capture(event: ObservationEvent): CaptureReceipt
  checkpoint?(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt>
}

export type ObservationSpanName =
  | 'sdk.agent.run'
  | 'sdk.agent.turn'
  | 'sdk.model.call'
  | 'sdk.provider.attempt'
  | 'sdk.tool.call'
  | 'sdk.compaction'
  | 'sdk.hook.call'
  | 'sdk.user.input.wait'
  | 'sdk.skill.operation'
  | 'sdk.memory.operation'
  | 'sdk.credential.operation'
  | 'sdk.integration.request'

export interface OpenObservationSpanInput {
  readonly name: ObservationSpanName
  readonly runId: string
  readonly parent?: CorrelationContext
  readonly correlation?: Omit<Partial<CorrelationContext>, 'traceId' | 'spanId' | 'parentSpanId' | 'runId'>
  readonly startedAt: string
  readonly monotonicMs: number
}

export interface ObservationSpan {
  readonly correlation: CorrelationContext
  readonly traceparent: string
  end(status: OperationStatus, endedAt: string, monotonicMs: number): void
}
```

`capture` is synchronous and must never execute network I/O. `checkpoint` captures the supplied event and waits until all accepted critical events for the same run with `sequence <= event.sequence` reach the configured durability boundary. A receipt is `durable: true` only when `boundary` is `local-durable` or `remote-acknowledged`; memory-only acceptance always reports `boundary: 'none'`. A reliable/audit bus with no exporter capable of reaching its configured boundary rejects checkpoints as `exporter-unavailable`.

Provider code calls `checkpoint` in audit mode immediately before each dispatch. Runtime owners also checkpoint their critical terminal event in reliable and audit mode: model-call end for a direct registry call, and run end for an agent run. In reliable mode, a terminal-checkpoint failure preserves the model/agent result and sets delivery incomplete in the report. In audit mode, a pre-dispatch failure throws `OBSERVABILITY_AUDIT_UNAVAILABLE` without calling `fetch`; a terminal-checkpoint failure throws the same stable error after finalization, does not retry the provider request, and leaves the provider outcome plus failed delivery receipt retrievable through `report`.

`openSpan` is synchronous and must not perform network I/O. It lets a configured tracing backend create the real span before the start event is captured, so the event, logger, outbound `traceparent`, and exported trace share one identity. The core invocation helper contains a throwing/invalid backend, records observer health, and falls back to a core span so operational/reliable model behavior is unchanged; audit durability is still enforced later by checkpoint. `end` is idempotent and contained at the port boundary; the ledger still treats a second runtime terminal event as a defect. The core/no-op implementation uses cryptographically random bytes from `globalThis.crypto`: trace IDs are 16 bytes/32 lowercase hex characters; span IDs are 8 bytes/16 lowercase hex characters; other operation IDs are 16-byte lowercase hex. All-zero IDs are regenerated. `sequence` starts at 1 for each `runId`, is a positive safe integer, and is assigned synchronously by the run scope before capture.

`occurredAt` is UTC ISO 8601 wall time. `monotonicMs` is elapsed time from the run scope's monotonic origin (`performance.now()` where available, otherwise a captured `Date.now()` delta). Latency uses monotonic time, never wall-clock subtraction.

## 4. Event vocabulary

The closed first-party event-name union is:

```ts
export type ObservationEventName =
  | 'sdk.agent.run'
  | 'sdk.agent.turn'
  | 'sdk.model.call'
  | 'sdk.provider.attempt'
  | 'sdk.provider.retry.scheduled'
  | 'sdk.tool.call'
  | 'sdk.compaction'
  | 'sdk.hook.call'
  | 'sdk.user.input.wait'
  | 'sdk.skill.operation'
  | 'sdk.memory.operation'
  | 'sdk.credential.operation'
  | 'sdk.integration.request'
  | 'sdk.observer.failure'
  | 'sdk.exporter.state'
  | 'sdk.log'
```

Operation events use `start` and `end`. Point events use `point`. The same `spanId` identifies a start/end pair; no second end is accepted by the ledger.

Required data fields are:

| Event | Phase | Priority | Required data |
|---|---|---|---|
| `sdk.agent.run` | start | critical | `agentId`, `mode`, `maxTurns` |
| `sdk.agent.run` | end | critical | `status`, `durationMs`, `completed`, aggregate usage/operation counts, error count, delivery summary; never the full call list |
| `sdk.agent.turn` | start/end | critical | turn number plus terminal reason/status/duration; no assistant text |
| `sdk.model.call` | start | critical | `provider`, `model`, `operation`, `turn`, `step` |
| `sdk.model.call` | end | critical | `status`, `durationMs`, `finishReason`, `usageReport`, `attemptCount` |
| `sdk.provider.attempt` | start | critical | `provider`, `model`, `attemptNumber`, `method`, `origin`, `dispatchState: 'not-sent'` |
| `sdk.provider.attempt` | end | critical | `status`, `durationMs`, `dispatchState`, `httpStatus?`, `usageReport`, `error?` |
| `sdk.provider.retry.scheduled` | point | critical | `nextAttemptNumber`, `delayMs`, `failureCode` |
| `sdk.tool.call` | start | critical | `toolName`, `turn`, `step`, `executionMode` |
| `sdk.tool.call` | end | critical | `status`, `durationMs`, `error?`, `resultBytes?` |
| `sdk.compaction` | start/end | critical | existing compaction ID/trigger plus terminal usage/savings/error |
| `sdk.hook.call` | start/end | critical | closed hook kind, terminal status/duration/safe error |
| `sdk.user.input.wait` | start/end | critical | reason `approval|question|handoff`, terminal status/duration; never answer text |
| `sdk.skill.operation` | start/end | critical | operation `discover|activate|read-resource`, source kind, terminal counts/status/error; no local path/content |
| `sdk.memory.operation` | start/end | critical | operation `load|append|compact|save`, backend kind, terminal counts/status/error; no message bodies |
| `sdk.credential.operation` | start/end | critical | `provider`, `operation`, terminal safe error; never token values |
| `sdk.integration.request` | start/end | critical | `integration: 'mcp'|'a2a'|'model-catalog'`, operation, endpoint origin, terminal status |
| `sdk.observer.failure` | point | critical | observer/exporter ID, failure kind, counter, safe error |
| `sdk.exporter.state` | point | critical | exporter ID, state, queued/dropped counts, last success/failure time |
| `sdk.log` | point | normal by default | `level`, `message`, `fields` |

`origin` is scheme + host + explicit non-default port only. URL paths, queries, headers, prompt content, tool arguments, and response bodies are absent under the default privacy policy.

Verbose token/text/image deltas are not lifecycle events. A diagnostic processor may opt into bounded delta events, but they use priority `verbose`, content policy still applies, and they never affect ledger closure.

## 5. Run and model-call APIs

Public streaming APIs return handles that remain valid when iteration stops:

```ts
export interface ModelCallHandle extends AsyncIterable<StreamChunk> {
  readonly runId: string
  readonly modelCallId: string
  readonly report: Promise<ModelCallReport>
}

export interface AgentRunHandle extends AsyncIterable<AgentRunEvent> {
  readonly runId: string
  readonly result: Promise<AgentResponse>
  readonly report: Promise<RunReport>
}
```

Existing `for await` code continues to work structurally. `ModelRegistry.stream()` returns `ModelCallHandle`; `AgentSession.stream()` and `streamPending()` return `AgentRunHandle`. `AgentSession.run()` awaits the same handle and includes `report` on `AgentResponse`.

Stopping event iteration aborts the operation as it does today, but an internal `finally` path independent of the public queue closes open spans, classifies usage, resolves `report`, and records exporter health. Public event consumption is never the sole observability path.

The registry accepts an optional invocation context separate from provider request data:

```ts
export interface ModelInvocationContext {
  readonly observation?: ObservationPort
  readonly correlation?: Partial<CorrelationContext>
  readonly terminalCheckpointOwner?: 'model-call' | 'agent-run'
}

registry.stream(options, context?)
```

`GenerateOptions` stays provider-request data and never carries exporter functions. `ModelAdapter.stream`/`prepareCall` receive a second internal invocation context so retries and HTTP attempts inherit IDs without AsyncLocalStorage. `terminalCheckpointOwner` defaults to `model-call`; the agent runtime sets `agent-run` so one run-end checkpoint covers all prior critical call/tool events instead of forcing a durable barrier after every nested call. This explicit propagation is required on Web runtimes.

## 6. Usage types and arithmetic

The existing `TokenUsage` remains an exact, complete normalized provider report:

- `inputTokens` is uncached input;
- `cacheReadTokens` and `cacheWriteTokens` are disjoint input buckets;
- `outputTokens` includes reasoning output;
- `reasoningTokens` is a detail/subset of output and is never added to totals;
- `totalTokens`, when present, is authoritative full-call total.

Partial and missing states use separate types:

```ts
export type UsageCoverage = 'complete' | 'partial' | 'estimated' | 'missing' | 'not-applicable'
export type DispatchState = 'not-sent' | 'sent' | 'unknown'

export interface UsageCounters {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

export interface AttemptUsageReport {
  readonly attemptId: string
  readonly spanId: SpanId
  readonly attemptNumber: number
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly dispatchState: DispatchState
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly error?: SafeErrorRecord
}

export interface ModelCallReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly modelCallId: string
  readonly spanId: SpanId
  readonly provider: string
  readonly model: string
  readonly status: OperationStatus
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly finishReason?: string
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly attempts: readonly AttemptUsageReport[]
  readonly possiblyBilledAttemptsWithoutUsage: number
  readonly authoritative: boolean
  readonly delivery: ObservationDeliverySummary
  readonly error?: SafeErrorRecord
}

export interface ObservationDeliverySummary {
  readonly mode: DeliveryMode
  readonly requiredBoundary: 'none' | 'local-durable' | 'remote-acknowledged'
  readonly reachedBoundary: 'none' | 'local-durable' | 'remote-acknowledged'
  readonly complete: boolean
  readonly acceptedCritical: number
  readonly rejectedCritical: number
  readonly pendingCritical: number
  readonly lastFailure?: SafeErrorRecord
}

export interface UsageCoverageSummary {
  readonly logicalCalls: number
  readonly attempts: number
  readonly complete: number
  readonly partial: number
  readonly estimated: number
  readonly missing: number
  readonly notApplicable: number
  readonly possiblyBilledAttemptsWithoutUsage: number
}

export interface RunUsageReport {
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly coverage: UsageCoverageSummary
  readonly authoritative: boolean
}

export interface RunOperationCounts {
  readonly total: number
  readonly success: number
  readonly error: number
  readonly aborted: number
  readonly rejected: number
  readonly unknown: number
}

export type TrackedOperationKind =
  | 'turn'
  | 'model-call'
  | 'provider-attempt'
  | 'tool'
  | 'compaction'
  | 'hook'
  | 'user-input'
  | 'skill'
  | 'memory'
  | 'credential'
  | 'integration'

export interface RunReport {
  readonly runId: string
  readonly traceId: TraceId
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly status: OperationStatus
  readonly usage: RunUsageReport
  readonly modelCalls: readonly ModelCallReport[]
  readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>
  readonly errors: readonly SafeErrorRecord[]
  readonly delivery: ObservationDeliverySummary
}
```

Every counter is a non-negative safe integer. Addition saturates at `Number.MAX_SAFE_INTEGER` and records health code `USAGE_COUNTER_OVERFLOW`; overflow makes the aggregate non-authoritative.

Provider normalization rejects, rather than clamps, negative, fractional, non-finite, unsafe, or wrong-type counters. A reported `totalTokens` smaller than the sum of known disjoint buckets is invalid. Invalid fields are omitted from `reported`, `USAGE_INVALID` is recorded with provider/model/call IDs but not raw payload, and coverage is recomputed as partial or missing. A protocol translator may document a provider-specific authoritative total that is larger than known buckets; the unexplained remainder is not invented as a named bucket.

Coverage rules, in order:

1. no dispatch invoked and this is proven: `not-applicable`;
2. every dispatched/possibly dispatched attempt has a complete provider report: `complete`;
3. any attempt has reported counters but at least one dispatched/unknown attempt lacks complete counters: `partial`;
4. no reported counters, an estimator produced values, and at least one dispatch may have occurred: `estimated`;
5. at least one dispatch may have occurred and neither reported nor estimated values exist: `missing`.

`authoritative` is true only for `complete` and `not-applicable`, with no overflow or invalid provider counters. A run with zero model calls is authoritative and has zeroed `reported` totals plus all coverage counts zero.

A standalone `ModelCallHandle.report` resolves after its model-call terminal checkpoint and therefore carries the final call delivery summary. Inside an agent run, the internal per-call report records the delivery snapshot at call closure; the final `RunReport` rebuilds/final-freezes its `modelCalls` array with the run-end delivery summary after the owning run checkpoint. No previously published frozen object is mutated.

When `totalTokens` is absent but all normalized buckets are complete, the ledger derives full total as uncached input + cache read + cache write + output. It never adds reasoning again. A provider-specific protocol may declare omitted cache buckets to mean zero; otherwise omission makes the report partial.

`TurnOutcome.usage` changes to optional and exists only when the run total is authoritative. `TurnOutcome.usageReport` is required. This intentionally removes the current false `0/0/0` representation for missing usage; the package is pre-1.0, so correctness wins over preserving that misleading shape.

## 7. Usage policy

Agent sessions accept:

```ts
export interface UsagePolicy {
  readonly onMissing?: 'warn' | 'estimate' | 'fail'
  readonly estimator?: UsageEstimator
}

export interface UsageEstimator {
  readonly id: string
  estimate(input: UsageEstimationInput): UsageCounters | Promise<UsageCounters>
}
```

Default is `onMissing: 'warn'`:

- keep the model result;
- mark coverage `missing`/`partial`;
- emit `USAGE_MISSING` warning with IDs but no content;
- if no cumulative `maxTotalTokens` budget is configured, allow the run to continue;
- if cumulative `maxTotalTokens` is configured, do not start another model dispatch after an unknown possibly billed attempt. End the turn/run with the new reason `{ kind: 'usage-unavailable', modelCallId }`; do not spend another call on a forced final answer. Per-request output caps remain enforceable independently.

`estimate` requires an estimator at configuration time. Estimates are stored only in `estimated`, never merged into `reported`, billing, or authoritative totals. When cumulative `maxTotalTokens` exists, the budget controller uses reported counters plus estimates for only the missing portions and marks the decision non-authoritative; an estimator failure follows `fail`. `fail` changes a successful logical call into stable error `USAGE_REQUIRED` after response completion; it cannot undo a request that was already sent and the report preserves that fact.

Cost is derived by a versioned `PricingResolver` over reported/estimated usage. Cost never belongs in `TokenUsage`. A cost record includes currency, pricing source ID/version, effective date, and whether input usage was authoritative.

## 8. Model and attempt state machines

The logical call starts before registry validation. The physical attempt starts only after serialization, URL/header validation, request-size checks, and credential resolution succeed.

| Case | Attempts | Call status | Coverage | Required terminal evidence |
|---|---:|---|---|---|
| validation/checkpoint rejects before fetch | 0 | rejected/error | not-applicable | call end, safe error |
| caller aborts before fetch | 0 | aborted | not-applicable | call end |
| fetch returns success + complete usage | 1 | success | complete | attempt end + call end |
| fetch returns success without usage | 1 | success | missing | attempt/call end + `USAGE_MISSING` |
| first attempt may be sent, fails without usage; retry succeeds with usage | 2 | success | partial | both attempt ends, retry point, call end, possibly-billed count 1 |
| fetch throws after invocation | 1 | error/aborted | missing or estimated | attempt dispatchState unknown |
| HTTP response received, body/stream fails | 1 | error/aborted | partial/missing | attempt dispatchState sent, request ID if present |
| custom adapter emits invalid chunks before external dispatch | adapter-declared | error | not-applicable only if adapter proves not sent | call end |
| public stream consumer stops | current attempts | aborted | based on dispatch state | internal terminal report resolves |

Immediately before `fetch`:

- operational/reliable mode captures `sdk.provider.attempt` start synchronously, then invokes fetch;
- audit mode checkpoints the same start event to durable storage, verifies `accepted && durable`, then invokes fetch;
- if the audit checkpoint fails, dispatch state remains `not-sent` and fetch is never invoked.

At terminal closure, operational mode captures only. Reliable and audit mode checkpoint the owning model-call/run terminal event, which drains all earlier accepted critical events for that scope through the same durability boundary. A failed reliable checkpoint produces `delivery.complete: false` without changing the provider outcome. A failed audit terminal checkpoint produces `OBSERVABILITY_AUDIT_UNAVAILABLE` after the report is finalized; the caller can inspect that report from the handle/error, and the SDK never retries the already dispatched request.

When fetch resolves to an HTTP response, dispatch state becomes `sent`. When the fetch promise rejects after invocation, state is `unknown` because the remote may have received the request. Provider request IDs are captured from success and error response headers and added only to terminal context/events.

Retry never repeats an attempt after any model chunk has reached the consumer. Each retry receives a fresh attempt ID and keeps the same logical model-call ID/span parent.

## 9. Run ledger

The ledger is an internal append-only state machine, not the exporter queue. Defaults:

- maximum 1,024 logical model calls per run;
- maximum 16 attempts per logical call;
- maximum 10,000 tool calls per run;
- maximum 16 MiB serialized ledger state;
- terminal reports retain summaries and safe errors, not prompt/tool bodies.

Exceeding a ledger limit stops the affected run with `LEDGER_LIMIT_EXCEEDED`; it does not silently stop accounting while the agent continues spending tokens.

The ledger maintains maps by span/modelCall/attempt/tool ID and rejects duplicate starts, duplicate ends, orphan ends, non-monotonic sequence values, and usage after terminal closure. Production mode converts the defect into a health event and terminal `unknown` state; test mode throws immediately. At run end, `closeOpenOperations()` emits one synthetic terminal end per still-open operation with status `unknown` and code `OPERATION_TERMINAL_MISSING`, then closes the run.

`RunReport` uses the normative shape above. Its status mirrors the terminal agent outcome without embedding assistant text, prompt bodies, or tool bodies. It is deeply frozen and JSON-safe. Agent responses carry the same report object; operation errors raised after run creation expose safe `traceId`, `runId`, optional `modelCallId`, and the finalized `RunReport` or `ModelCallReport` through a read-only `report` property. This is how `AgentSession.run()` callers can recover the report even though they did not retain a streaming handle.

## 10. Structured logger

The Universal logging API is:

```ts
export interface SdkLogger {
  child(fields: Readonly<JsonObject>): SdkLogger
  trace(message: string, fields?: Readonly<JsonObject>): void
  debug(message: string, fields?: Readonly<JsonObject>): void
  info(message: string, fields?: Readonly<JsonObject>): void
  warn(message: string, fields?: Readonly<JsonObject>): void
  error(message: string, fields?: Readonly<JsonObject>): void
  fatal(message: string, fields?: Readonly<JsonObject>): void
}
```

`child` merges immutable safe fields and inherits correlation context. Providers, tools, skills, MCP, A2A, hooks, and credentials receive a scoped logger from their invocation context. Exporters and processors do not receive this normal logger because logging while exporting would feed the queue recursively. They receive a protected internal diagnostic sink that updates health and emits at most one `sdk.observer.failure` through the protected path; it never creates `sdk.log` and never calls the failing exporter again. Production source does not call `console.*` except CLI presentation code and the final emergency health callback.

Log levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Default minimum is `info`. Error fields use a safe structured record:

```ts
export interface SafeErrorRecord {
  readonly type: string
  readonly message: string
  readonly code?: string
  readonly retryable?: boolean
  readonly status?: number
  readonly causeTypes?: readonly string[]
  readonly stack?: string
}
```

Log priority mapping is fixed: `trace`/`debug` are verbose, `info`/`warn` are normal, and `error`/`fatal` are critical. Logs remain supplemental: the critical terminal operation event independently carries the safe error code/status, so disabling logs cannot erase failure accounting.

Stacks are omitted by default because they reveal local paths. Enabling stacks is a diagnostic privacy option. Thrown non-Error values are safely stringified with a 2,048-character ceiling and hostile coercion containment.

## 11. Observation bus, queues, and health

Default `createObservability()` settings:

```ts
{
  mode: 'operational',
  maxQueueEvents: 10_000,
  maxQueueBytes: 16 * 1024 * 1024,
  maxBatchEvents: 256,
  maxBatchBytes: 512 * 1024,
  flushTimeoutMs: 10_000,
  shutdownTimeoutMs: 30_000,
  content: 'none'
}
```

Processors are synchronous, ordered, and run before queue fan-out:

1. schema validation and safe cloning;
2. content policy;
3. secret/header/key redaction;
4. size/depth truncation;
5. attribute/cardinality normalization;
6. built-in trace/metric/log projection, including synchronous attributes on an open OTel span;
7. user processors;
8. exporter queues.

An invalid or throwing user processor rejects only that event from external exporter queues, increments health, and emits `sdk.observer.failure` through a protected internal path that skips user processors. The already-safe built-in ledger/trace closure is not undone. If that path also fails, the in-memory health snapshot still increments.

Queue eviction order is verbose oldest, then normal oldest. Critical events are never sampled or chosen for eviction. If the queue contains only critical events and is full:

- operational mode rejects the new event, increments `criticalRejected`, and continues runtime work;
- reliable mode rejects capture, makes the next flush/report return incomplete delivery, but does not change the model result;
- audit mode fails the checkpoint and prevents a new external dispatch.

This is the honest boundary between bounded memory and “never drop.” No mode claims a critical event was retained when capacity was exhausted.

Health API:

```ts
export interface ObservationHealthSnapshot {
  readonly state: 'disabled' | 'healthy' | 'degraded' | 'failed' | 'closed'
  readonly queuedEvents: number
  readonly queuedBytes: number
  readonly accepted: number
  readonly exported: number
  readonly droppedVerbose: number
  readonly droppedNormal: number
  readonly criticalRejected: number
  readonly processorFailures: number
  readonly exporterFailures: number
  readonly flushTimeouts: number
  readonly lastExportAt?: string
  readonly lastFailure?: SafeErrorRecord
}
```

Health counters are monotonic for one bus lifetime. `onHealthChange` is optional, synchronous, separately contained, and is the only emergency path allowed to write to CLI stderr when explicitly configured by a CLI host.

## 12. Exporter and lifecycle contracts

```ts
export interface ObservationBatch {
  readonly schemaVersion: 1
  readonly batchId: string
  readonly createdAt: string
  readonly events: readonly ObservationEvent[]
}

export interface ExportAck {
  readonly batchId: string
  readonly accepted: boolean
  readonly retryable: boolean
}

export interface ObservationExporter {
  readonly id: string
  readonly supportedBoundaries?: readonly ObservationBoundary[]
  stage?(event: ObservationEvent): void | Promise<void>
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  shutdown?(signal: AbortSignal): Promise<void>
}

export interface ObservationExporterRegistration {
  readonly exporter: ObservationExporter
  readonly requirement: 'required' | 'best-effort'
  readonly boundary: 'none' | 'local-durable' | 'remote-acknowledged'
}

export interface FlushResult {
  readonly complete: boolean
  readonly exportedEvents: number
  readonly pendingEvents: number
  readonly rejectedCritical: number
  readonly timedOut: boolean
}
```

These names remain the advanced marker-free, caller-owned bus contract after the
core package move. They are not repurposed for `AgentRuntime` plugins. The
high-level composition layer uses `ObservationExporterPlugin`,
`ObservationDeliveryBatch`, `ObservationDeliveryAck`, and
`RuntimeObservationExporterRegistration`; official exporter factories return
that plugin type. This separation preserves existing source signatures while
adding marker validation, readiness, atomic run records, acknowledgment identity,
and explicit owned/borrowed lifecycle to the recommended path.

`stage` is an optional local-durability hook. The bus calls it synchronously,
after both privacy passes and in-memory capacity acceptance, and before
`capture()` returns. The hook must start its local write before returning when
its backend is ready; a returned promise is contained but is not awaited and is
not a durability claim. `export()` waits for the corresponding staged writes
and returns the measured boundary acknowledgment. This additive hook is needed
by both IndexedDB and the Node journal: an exporter-only API invoked first at
flush cannot protect events from a crash between capture and checkpoint. Hosts
should await a durable exporter's explicit `ready()` before installing it when
they need the strongest capture-time staging guarantee.

`flush()` drains events present at its start and returns a result; it does not throw for ordinary exporter failure. Invalid options and already-closed misuse throw. `shutdown()` is idempotent, stops new capture, flushes, shuts exporters in reverse registration order, and returns the final result.

Operational mode permits only best-effort delivery claims even if a durable exporter is present. Reliable and audit `createObservability()` configuration requires at least one `required` registration with a non-`none` boundary. A checkpoint succeeds only after every required registration reaches its declared boundary through the supplied sequence; best-effort exporters do not block it, but their failures still appear in health. Duplicate exporter IDs, a memory exporter marked durable, or a boundary unsupported by that exporter are configuration errors. This makes “durable” a host-selected, testable contract rather than “any exporter happened to accept.”

No Node process hooks are installed automatically. `observability-node` exports opt-in `installNodeObservabilityLifecycle()` and returns a disposer. Edge hosts pass `ctx.waitUntil(observability.flush())`. Browser hosts opt into page visibility/pagehide flushing; unload is best effort and never described as durable.

## 13. Fetch exporter

The current advanced `FetchObservationExporter` posts the preserved
`ObservationBatch` JSON contract. The recommended post-migration
`fetchObservationExporter()` plugin posts `ObservationDeliveryBatch` JSON to an
explicit HTTPS endpoint. Both paths use the same transport rules below; their
wire schemas and acknowledgments remain distinct and must not be accepted as
interchangeable merely because both carry a `batchId`. Default request rules:

- method POST;
- `content-type: application/json`;
- `idempotency-key: <batchId>`;
- redirect mode `error`;
- 10-second request timeout;
- at most 256 events and 512 KiB per batch;
- retry 408, 425, 429, and 5xx plus network failures;
- exponential full-jitter delay starting 250 ms, capped at 30 seconds;
- respect `Retry-After` up to 60 seconds;
- maximum 8 attempts per active flush.

The success response is either 204 or JSON `{ "acceptedBatchId": "..." }`; a JSON acknowledgment must match the sent ID. Other 2xx bodies are protocol errors. A retry sends the same batch and event IDs and never repeats a provider request.

Headers are configured by the host and are never copied into events. Endpoint validation rejects credentials in URLs, non-HTTPS by default, and cross-origin redirects.

## 14. Browser durable queue

`observability-browser` uses IndexedDB database `ai-agent-sdk-observability`, schema version 1, stores `events`, `batches`, and `meta`, and keys events by `[runId, sequence]` with a unique `eventId` index.

Reliable mode starts the IndexedDB transaction on critical capture but the synchronous receipt remains `durable: false`; the terminal checkpoint waits for transaction commit before reporting local durability. Audit mode is supported only when the pre-dispatch `checkpoint` completes the IndexedDB transaction. Quota or blocked-upgrade failure makes the bus degraded/rejected; it never falls back to claiming memory is durable.

Defaults are 50,000 events or 64 MiB per origin. Eviction uses the same priority rules and never evicts an unacknowledged critical event. If only critical data remains at the limit, new reliable/audit capture fails visibly.

The browser exporter reports only `local-durable`. `stage()` stores the exact
privacy-processed event; `export()` waits for those transactions, assigns the
events to a local batch manifest, and acknowledges only after commit. Stored
events survive a page close and remain unacknowledged until the host calls
`acknowledgeBatch()` after its selected remote destination confirms delivery.
`recoverEvents()` returns the retained events in staging order so the host can
rebuild its own remote batches without coupling this Browser package to a
network exporter. Evicted normal/verbose events are treated as intentionally
dropped during a later local batch commit; a missing critical record always
fails the checkpoint. The opt-in lifecycle adapter flushes on hidden visibility
and `pagehide`, contains its callback failures, and makes no unload durability
claim.

## 15. Node durable journal

`observability-node` writes append-only UTF-8 JSONL under an explicit root. Defaults: directory mode `0700`, file mode `0600`, UTC-day or 64 MiB rotation, whichever comes first, 1 GiB total retained bytes, and 7-day retention for fully acknowledged segments. Each bus instance creates a unique `<utc-date>-<pid>-<random>.jsonl` segment with exclusive create; processes never append to the same segment. The root must not be a symlink, segment opens use `O_NOFOLLOW` where supported, and the implementation revalidates the opened file identity before writing.

Each line is:

```json
{"schemaVersion":1,"eventId":"...","payloadJson":"{\"schemaVersion\":1,...}","sha256":"lowercase-hex"}
```

`payloadJson` is the exact compact `JSON.stringify` result of the already validated and bounded event. The checksum covers the exact UTF-8 bytes of that string, so recovery does not depend on property reserialization or an unspecified canonical-JSON algorithm. Recovery verifies the checksum before parsing and schema-validating `payloadJson`. One writer serializes appends per journal. Durability boundaries:

- operational: append buffering is allowed; no durability claim;
- reliable: `fdatasync` after at most 100 ms or 256 critical records, and flush waits for sync;
- audit: append + `fdatasync` for the checkpoint record before provider dispatch.

Recovery validates every complete line. A truncated final line is removed. A corrupt final complete line is quarantined with the original file; mid-file corruption stops recovery with `OBSERVABILITY_JOURNAL_CORRUPT`. Records are never silently skipped.

Exporter acknowledgment is stored in a sidecar cursor using write-temp, file sync, atomic rename in the same directory, then directory sync where supported. Journal segments are deleted only after every event is acknowledged and the cursor is durable. Age/size cleanup removes oldest acknowledged segments first and never deletes an unacknowledged critical record. If the cap contains only unacknowledged data, new capture/checkpoints fail visibly under the queue rules. Rotation and cleanup errors are health failures, not fatal to a successful model result outside audit mode.

## 16. Privacy, redaction, and size limits

Content policy is one of `none`, `metadata`, `redacted`, `full`; default is `none`.

- `none`: no prompt, completion, reasoning, tool argument/result, image, raw request/response, auth token, cookie, or local file content.
- `metadata`: counts, types, MIME types, and lengths only.
- `redacted`: content passes configured redactors before storage.
- `full`: explicit high-risk diagnostic mode; still removes credentials and applies hard size limits.

Hard defaults per event:

- 64 top-level data fields;
- key length 128 characters;
- string length 2,048 characters;
- error message 2,048 characters;
- array length 100;
- object depth 8;
- serialized event size 64 KiB.

Truncation adds safe metadata (`observability.truncated`, fields/counts) rather than silently changing text. Secret-key matching is case-insensitive and includes authorization, proxy-authorization, cookie, set-cookie, api-key variants, access/refresh/id tokens, client secret, password, and session secrets. Headers use a positive allowlist; redaction is not a negative list alone.

The current exact provider request logger becomes a separately imported Node diagnostic exporter. Enabling it requires `content: 'full'` plus `allowWireBodies: true`; its constructor throws otherwise. It is never enabled by the human harness default after migration.

Content hashes are not produced by the synchronous default processor because they can leak equality information and Web Crypto hashing is asynchronous. A host that needs hashes must add an explicit pre-capture transform, choose the hash/keying policy, and treat the result as captured content under the same redaction and size rules.

## 17. Metrics and cardinality

The projection emits these initial metric instruments:

- `ai_agent_sdk.model.call.duration` histogram, milliseconds;
- `ai_agent_sdk.provider.attempt.duration` histogram;
- `ai_agent_sdk.tool.call.duration` histogram;
- `ai_agent_sdk.token.usage` counter by token type and source `reported|estimated`;
- `ai_agent_sdk.usage.coverage` counter by coverage state;
- `ai_agent_sdk.provider.retry` counter;
- `ai_agent_sdk.observation.dropped` counter by priority/reason;
- `ai_agent_sdk.exporter.failure` counter.

Allowed metric attributes are provider, operation, status, error code, tool execution mode, usage coverage, and exporter ID. Model ID, tool name, run/conversation IDs, request IDs, URLs, user content, and arbitrary log fields are forbidden metric labels. They remain trace/log fields where policy permits.

## 18. OpenTelemetry bridge

`observability-otel` contributes an `openSpan` backend and event processor to `createObservability()`, using caller-supplied `Tracer`, `Meter`, and optional logger API objects. The package peers on `@opentelemetry/api@^1.9.1` and optional `@opentelemetry/api-logs@^0.221.0`; it does not install a global provider or choose an OTLP exporter.

Mapping is pinned in tests to the OpenTelemetry semantic-conventions repository commit `5ca9052bc796ef1e497200b1d558fd87a201f335`. The GenAI convention is still marked Development, so internal event names and ledger fields remain the stable SDK contract. Mapping changes do not rewrite stored internal events.

Rules:

- `openSpan` calls the supplied tracer synchronously and returns the actual valid `span.spanContext()` IDs; start/end events use those IDs rather than creating a second trace identity;
- explicit parent lookup uses a bridge-owned map keyed by SDK span ID and an explicit OpenTelemetry `Context`; it does not rely on AsyncLocalStorage or ambient context;
- one `sdk.model.call` span is the GenAI client span and contains automatic retries;
- provider attempts are child HTTP/internal spans, not additional logical GenAI calls;
- `gen_ai.usage.input_tokens` and output tokens are emitted only when defensible from reported counters;
- estimated counters carry `ai_agent_sdk.usage.source=estimated` and do not impersonate provider-reported metrics;
- prompts/completions are opt-in and pass the SDK privacy processor first;
- `traceparent` is rendered from the same returned OpenTelemetry span context;
- if the supplied tracer returns an invalid/all-zero no-op context, the bridge records `OTEL_PROVIDER_UNCONFIGURED`, falls back to core Web Crypto IDs for ledger correlation, and makes no false claim that a trace was exported;
- the event processor emits metrics/logs and attributes onto the already opened span; it never creates a competing span from start/end events.

The API bridge can observe synchronous API misuse but cannot know whether a caller-owned OpenTelemetry SDK/exporter later delivered data. Its delivery summary never marks OTLP acknowledged. Hosts that require SDK/exporter failure visibility wire their OpenTelemetry diagnostic/error handler into the SDK protected health callback or use an SDK-owned acknowledged Fetch/journal exporter as the required delivery boundary.

## 19. Stable error codes

Add at minimum:

```text
OBSERVABILITY_AUDIT_UNAVAILABLE
OBSERVABILITY_CAPTURE_REJECTED
OBSERVABILITY_PROCESSOR_FAILED
OBSERVABILITY_EXPORT_FAILED
OBSERVABILITY_FLUSH_TIMEOUT
OBSERVABILITY_JOURNAL_CORRUPT
OBSERVABILITY_JOURNAL_IO
OBSERVABILITY_BROWSER_QUOTA
OTEL_PROVIDER_UNCONFIGURED
OPERATION_TERMINAL_MISSING
LEDGER_LIMIT_EXCEEDED
USAGE_MISSING
USAGE_REQUIRED
USAGE_INVALID
USAGE_COUNTER_OVERFLOW
```

User-facing errors carry safe context properties separately from the message. Provider/tool body content and credentials never enter these errors.

## 20. Test plan and acceptance gates

Deterministic contract tests cover:

- every operation start has one end across success, validation rejection, retry, stream error, timeout, abort, hook failure, and consumer stop;
- duplicate/orphan terminal detection;
- success with complete usage, success without usage, partial retry accounting, zero reported tokens, estimates, missing policy warn/estimate/fail;
- reasoning tokens not double-counted;
- direct registry calls and full agent runs produce reports;
- success response provider request IDs enter context;
- observer rejection/timeout and exporter failure enter health;
- critical/normal/verbose queue eviction and hard-cap behavior;
- redaction before every exporter, hostile keys, cyclic/non-JSON input, size/depth truncation;
- fetch batch idempotency, retry classes, mismatched ack, redirect rejection;
- IndexedDB crash/reopen/quota paths;
- Node journal partial tail, checksum corruption, rotation, permissions, fsync modes, cursor recovery;
- OpenTelemetry span topology and token mapping;
- no direct `console.*` in runtime packages;
- packed Edge/browser/Node runtime matrix.

Live Codex acceptance uses `gpt-5.6-luna` and asserts a complete positive usage report plus correlated run/model/attempt IDs. It is separate from normal unit tests because it uses real credentials and tokens.

The observability implementation is done only when every test above passes, reports remain retrievable after stream cancellation, no missing state renders as zero, and operational/reliable/audit delivery claims match measured receipts and health counters.
