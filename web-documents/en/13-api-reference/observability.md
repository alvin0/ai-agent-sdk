# Observability packages

Four packages, one bus. Pick by **where the events need to land**.

| Package | Runtime | Boundary | Composition slot |
| --- | --- | --- | --- |
| `observability-fetch` | Universal | `remote-acknowledged` | `runtime.observability.exporters` |
| `observability-node` | Node | `local-durable` | `runtime.observability.exporters` |
| `observability-browser` | Browser | `local-durable` | `runtime.observability.exporters` |
| `observability-otel` | Universal | — (processor) | `runtime.observability.openSpan-processors` |

---

## `@ai-agent-sdk/observability-fetch`

Universal acknowledged HTTPS exporter. Sends bounded JSON batches with an
idempotency key and retries **only the observation batch** — not the
model/provider operation that produced it.

```ts
export {
  FetchObservationExporter,
  fetchObservationExporter,
  type FetchObservationExporterOptions,
}
export { flushObservabilityWithWaitUntil, type WaitUntil }
```

```ts
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
| Accepted responses | HTTP 204, or `{ "acceptedBatchId": "<batchId>" }` |
| Retried | network failures, 408, 425, 429, 5xx — identical serialized batch, bounded full jitter |
| Not retried | every other response |
| Transport policy | HTTPS required except an explicitly enabled localhost/loopback test endpoint; redirects and cross-origin responses rejected |

On an Edge host, hand the flush promise to the platform's explicit `waitUntil`:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

The package never assumes a platform global.

---

## `@ai-agent-sdk/observability-node`

Node-only durable observation journal plus explicit lifecycle and diagnostic
helpers. **The journal root is always caller-supplied.**

Entrypoints: `.`, `./journal`, `./diagnostic`. The root re-exports both.

```ts
export {
  JsonlObservationJournalExporter,
  jsonlObservationExporter,
  recoverRuntimeObservationJournal,
  recoverJournal,
  type JournalDurabilityMode, type JournalRecoveryRecord,
  type JournalRecoveryResult, type JournalStats,
  type RuntimeJournalRecoveryRecord, type RuntimeJournalRecoveryResult,
  type JsonlObservationJournalOptions,
}
export {
  installNodeObservabilityLifecycle,
  NODE_OBSERVATION_ERROR_CODES, NodeObservationError,
  type NodeLifecycleOptions, type NodeLifecycleTarget, type NodeObservationErrorCode,
}
```

```ts
const runtime = await createAgentRuntime({
  providers: [provider],
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: jsonlObservationExporter({ rootDir: './observations', mode: 'reliable' }),
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

await runtime.close()
const recovered = await recoverRuntimeObservationJournal('./observations')
```

The factory is **inert** — filesystem resources are acquired only when
`createAgentRuntime()` calls its `ready()` lifecycle boundary. Records use
checksum-framed JSONL, private directory/file modes, unique segments, atomic
acknowledgment cursors, bounded retention, and strict corruption recovery.

The runtime adapter persists privacy-filtered events and atomic terminal run
records in `runtime-delivery/`, acknowledging their IDs separately. You still
close the runtime explicitly; an **owned** exporter is closed by the runtime
after all active runs settle.

`recoverRuntimeObservationJournal()` verifies checksums and returns both event
and terminal-run records. `recoverJournal()` remains the advanced legacy-journal
recovery API.

### `./diagnostic` — exact provider wire

A **separate high-risk capability** that refuses construction unless both
`content: 'full'` and `allowWireBodies: true` are set.

```ts
export {
  createDiagnosticWireLogger,
  createDailyJsonlRequestLogger,
  combineProviderRequestLoggers,
  type DiagnosticWireLoggerOptions, type ProviderWireLogRecord,
  type ProviderWireLogger, type DailyJsonlRequestLogger,
  type DailyJsonlRequestLoggerOptions, type ProviderRequestLogLike,
}
```

Nothing installs process lifecycle handlers automatically.

---

## `@ai-agent-sdk/observability-browser`

Browser-only local durability. The exporter stages privacy-processed events in
IndexedDB during **synchronous capture** and confirms `local-durable` only after
the transaction commits at flush/checkpoint.

```ts
export {
  IndexedDbObservationExporter,
  indexedDbObservationExporter,
  BROWSER_OBSERVATION_ERROR_CODES, BrowserObservationError,
  type BrowserObservationErrorCode, type BrowserQueueStats,
  type IndexedDbObservationExporterOptions,
}
export { installBrowserObservabilityLifecycle, type BrowserLifecycleOptions }
```

```ts
const queue = indexedDbObservationExporter()

const observability = createObservability({
  mode: 'reliable',
  exporters: [{ exporter: queue, requirement: 'required', boundary: 'local-durable' }],
})
```

Database defaults to `ai-agent-sdk-observability`, schema version 1, with
`events`, `batches`, and `meta` stores.

Stored events remain **unacknowledged** until the host calls
`acknowledgeBatch()` after its own remote sink confirms delivery.
`recoverEvents()` exposes crash/reopen recovery without importing a network
exporter.

`installBrowserObservabilityLifecycle()` is **opt-in** and flushes on hidden
visibility and `pagehide`. It makes **no unload-durability claim**.

---

## `@ai-agent-sdk/observability-otel`

Universal mapping bridge for **caller-supplied** OpenTelemetry API objects.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/observability-otel \
  @opentelemetry/api @opentelemetry/api-logs
```

```ts
export {
  createOpenTelemetryBridge,
  OTEL_SEMANTIC_CONVENTIONS_COMMIT,
  OpenTelemetryBridgeError,
  type OpenTelemetryBridge, type OpenTelemetryBridgeOptions,
  type OpenTelemetryLogEnabledOptions, type OpenTelemetryLogger,
  type OpenTelemetryLogRecord,
}
```

```ts
const bridge = createOpenTelemetryBridge({
  tracer: tracerProvider.getTracer('my-agent'),
  meter: meterProvider.getMeter('my-agent'),
  // logger: loggerProvider.getLogger('my-agent'),
})

const observation = createObservability({
  openSpan: bridge.openSpan,
  processors: [bridge.processor],
})
```

It creates **real spans synchronously**, keeps explicit parent contexts without
ambient context or `AsyncLocalStorage`, and maps privacy-processed SDK events to
spans, metrics, and optional logs.

The package installs **no global provider**, owns no SDK or OTLP exporter,
performs no network I/O, and never claims telemetry delivery. Configure a journal
or an acknowledged exporter separately when delivery guarantees are required.

Content attributes are disabled by default. Mapping prompt/completion bodies
requires `content: 'full'` on **both** the bridge and the SDK observability bus.

The application keeps ownership of provider registration, processors, exporters,
flushing, and shutdown.

## Read next

- [Observability concepts](/en/10-advanced/observability)
- [Observability configuration](/en/10-advanced/observability)
