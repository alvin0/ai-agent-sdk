# Observability

One structured observation bus records model calls, physical provider attempts,
usage coverage, retries, credential/catalog operations, safe errors, and
correlated application logs — with `content: 'none'` as the default.

## Compose it

Two exporter shapes exist and they are **not** interchangeable — tsc will say so:

| Registration point | Exporter type it accepts | What satisfies it |
| --- | --- | --- |
| `createAgentRuntime({ observability: { exporters } })` | `ObservationExporterPlugin` | the package factories: `fetchObservationExporter()`, `jsonlObservationExporter()`, `indexedDbObservationExporter()` |
| `createObservability({ exporters })` (bus-level) | `ObservationExporter` | `MemoryObservationExporter`, `TestObservationExporter`, `defineObservationExporter()` |

Runtime-owned path — what an application normally wants:

```ts
const runtime = await createAgentRuntime({
  providers,
  resource: { serviceName: 'checkout', environment: 'production' },
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter,
      ownership: 'owned',          // or borrowed — you close it
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

runtime.logger({ fields: { component: 'checkout-agent' } }).info('agent initialized')
```

Bus-level path, when you need the `Observability` object itself:

```ts
import { createObservability, MemoryObservationExporter } from '@alvin0/ai-agent-sdk-core/observability'

const observability = createObservability({
  exporters: [{ exporter: new MemoryObservationExporter(), requirement: 'best-effort', boundary: 'none' }],
})

observability.health()
await observability.flush()
await observability.shutdown()
new ModelRegistry({ observation: observability })
```

`MemoryObservationExporter` is for **test and local inspection only** — it never
claims durability.

## Three orthogonal knobs

```ts
type DeliveryMode = 'operational' | 'reliable' | 'audit'   // how hard the bus tries
requirement: 'required' | 'best-effort'                     // may this exporter fail?
type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'
```

Boundary is what an exporter is honestly **claiming**. Memory delivery never
claims durability; `reliable` and `audit` require a durable exporter package.

## Full runtime observability options

```ts
{
  mode?: DeliveryMode
  content?: 'none' | 'metadata'
  minimumLogLevel?: LogLevel
  exporters?: readonly RuntimeObservationExporterRegistration[]
  processors?: readonly ObservationProcessor[]
  redactors?: readonly ContentRedactor[]
  includeErrorStacks?: boolean
  openSpan?: (input: OpenObservationSpanInput) => ObservationSpan
  maxQueueEvents?: number
  maxQueueBytes?: number
  maxBatchEvents?: number
  maxBatchBytes?: number
  flushTimeoutMs?: number
  shutdownTimeoutMs?: number
}
```

## The event envelope

```ts
interface ObservationEnvelope<TName extends string, TData> {
  schemaVersion: 1
  eventId: string          // deduplicates exporter retries
  sequence: number         // monotonic; a gap means a lost event
  name: TName
  occurredAt: string       // source time, not exporter receipt time
  phase: 'start' | 'end' | 'point'
  monotonicMs: number
  priority: 'critical' | 'normal' | 'verbose'
  resource: { sdkName: 'ai-agent-sdk'; sdkVersion: string; serviceName?: string
              serviceVersion?: string; runtime: 'browser' | 'edge' | 'node' | 'unknown'
              runtimeId?: string; environment?: string; attributes?: Record<string, JsonValue> }
  correlation: CorrelationContext
  data: TData
}
```

`priority` drives sampling, buffering, and backpressure. **Critical events are
never sampled**, and every start has exactly one terminal event.

## Correlation ids have separate lifetimes

| Identifier | Lifetime |
| --- | --- |
| `traceId` | One distributed trace |
| `runId` | One agent invocation |
| `conversationId` | Multiple invocations in one conversation |
| `turnId` | One user/agent turn |
| `modelCallId` | One **logical** model operation, retries included |
| `attemptId` | One **physical** provider attempt |
| `toolCallId` | One requested tool execution |
| `providerRequestId` | Provider-assigned id when available |
| `sessionId` | Host-defined product session |
| `sequence` | Ordered position in one run ledger |

Do not overload `toolCallId` for model calls or HTTP attempts.

## Critical events

| Operation | Event | Phases |
| --- | --- | --- |
| Agent run | `sdk.agent.run` | start/end |
| Agent turn | `sdk.agent.turn` | start/end |
| Model call | `sdk.model.call` | start/end |
| Provider attempt | `sdk.provider.attempt` | start/end |
| Retry scheduled | `sdk.provider.retry.scheduled` | point |
| Tool execution | `sdk.tool.call` | start/end |
| Skill operation | `sdk.skill.operation` | counts only, never path or content |
| Memory operation | `sdk.memory.operation` | counts only, never bodies |

The complete `ObservationEventName` union:

```ts
'sdk.agent.run' | 'sdk.agent.turn' | 'sdk.model.call' | 'sdk.provider.attempt'
| 'sdk.provider.retry.scheduled' | 'sdk.tool.call' | 'sdk.compaction'
| 'sdk.hook.call' | 'sdk.user.input.wait' | 'sdk.skill.operation'
| 'sdk.memory.operation' | 'sdk.credential.operation' | 'sdk.integration.request'
| 'sdk.observer.failure' | 'sdk.exporter.state' | 'sdk.log'
```

## Exporter packages

**HTTPS telemetry — Universal**

```ts
import { fetchObservationExporter, flushObservabilityWithWaitUntil } from '@alvin0/ai-agent-sdk-observability-fetch'

const exporter = fetchObservationExporter({
  endpoint: 'https://telemetry.example.com/v1/observations',
  headers: { authorization: `Bearer ${telemetryToken}` },
})
```

| Behaviour | Value |
| --- | --- |
| Transport | POST JSON with `idempotency-key: <batchId>` |
| Request timeout | 10 s |
| Batch caps | 256 events / 512 KiB |
| Accepted | HTTP 204, or `{ "acceptedBatchId": "<batchId>" }` |
| Retried | network failures, 408, 425, 429, 5xx — identical serialized batch, bounded full jitter |
| Transport policy | HTTPS required except an explicitly enabled loopback test endpoint; redirects and cross-origin responses rejected |

On Edge, hand the flush promise to the platform:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

**JSONL journal — Node**

```ts
import { jsonlObservationExporter, recoverRuntimeObservationJournal } from '@alvin0/ai-agent-sdk-observability-node'

exporter: jsonlObservationExporter({ rootDir: './observations', mode: 'reliable' })

await runtime.close()
const recovered = await recoverRuntimeObservationJournal('./observations')
```

The factory is **inert** — filesystem resources are acquired only when
`createAgentRuntime()` calls its `ready()` boundary.

**IndexedDB queue — browser**

```ts
import {
  IndexedDbObservationExporter,
  indexedDbObservationExporter,
  installBrowserObservabilityLifecycle,
} from '@alvin0/ai-agent-sdk-observability-browser'

const queue = indexedDbObservationExporter()   // pass to createAgentRuntime

// The recovery API lives on the CONCRETE class, not on the plugin view:
const durable = new IndexedDbObservationExporter()
const pending = await durable.recoverEvents()               // readonly ObservationEvent[]
for (const batchId of await durable.pendingBatchIds()) {
  await durable.acknowledgeBatch(batchId)                   // one batch id, not an event array
}
await durable.stats()
```

```ts
installBrowserObservabilityLifecycle(observation: Pick<Observability, 'flush'>,
                                     options?: BrowserLifecycleOptions): () => void
```

It returns an uninstall function, and it needs something with `flush()` — an
`Observability` from `createObservability()`. **`AgentRuntime` has no `flush()`**,
so you cannot hand it the runtime; with a runtime-owned bus, the final flush
happens in `runtime.close()` and you drive recovery through the concrete
exporter above.

Database defaults to `ai-agent-sdk-observability`, schema version 1, with
`events`, `batches`, `meta` stores. Stored events stay **unacknowledged** until
the host calls `acknowledgeBatch()` after its own remote sink confirms.
`recoverEvents()` gives crash/reopen recovery without importing a network
exporter. `installBrowserObservabilityLifecycle()` is opt-in, flushes on hidden
visibility and `pagehide`, and makes **no unload-durability claim**.

**OpenTelemetry — Universal**

`@alvin0/ai-agent-sdk-observability-otel` is a mapping bridge for
**caller-supplied** OpenTelemetry API objects. It does not bundle an SDK.

## Projections and diagnostics

```ts
import { projectLog, projectMetrics, projectTrace } from '@alvin0/ai-agent-sdk-core/observability'

runtime.diagnostics()   // RuntimeDiagnosticSnapshot, bounded ring
```
