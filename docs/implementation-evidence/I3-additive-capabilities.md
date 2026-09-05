# I3 additive-capability evidence

The recommended additive factories now exist in the built packages without
repurposing their advanced compatibility classes. Filesystem skills retain the
marker-free `fileSystemSkills()` route and add the lazy versioned
`fileSystemSkillProviderPlugin()`. MCP retains inert advanced client constructors
plus explicit abortable `connectMcpHttp()` / `connectMcpStdio()` and caller-owned
reported close. Fetch, IndexedDB and JSONL expose inert versioned exporter
factories carrying their full production option bags.

`fetchObservationExporter()` sends the runtime `ObservationDeliveryBatch`, retries
one byte-identical body/idempotency key internally, and acknowledges event and
terminal-run identities separately. `indexedDbObservationExporter()` defers DB
acquisition to runtime readiness, stages both privacy-processed events and atomic
terminal run records, and acknowledges them only after the batch transaction
commits. The advanced IndexedDB class remains directly available and its recovery
API returns the established event surface.

OpenTelemetry remains `createOpenTelemetryBridge({ tracer, meter, logger? })`.
The high-level runtime accepts and snapshots typed `openSpan`, processor and
redactor callbacks plus queue, batch, flush and shutdown bounds. Runtime close
never calls or owns the supplied tracer, meter, logger or provider. The Browser
tarball fixture composes that borrowed bridge with an owned IndexedDB exporter in
one real Chromium runtime and confirms the optional logs peer is not installed.

Ownership evidence is explicit rather than inferred from a generic plugin list:

- filesystem construction performs no I/O; list/load/resource work is lazy,
  bounded, observable and abortable;
- a connected MCP source remains ready after runtime construction failure and
  after an active run is aborted/quiesced by runtime close; only the caller's
  subsequent `closeWithReport()` closes it;
- exporter startup/rollback/active-run close matrices cover owned and borrowed
  readiness success, rejection, timeout and abort; borrowed exporters are never
  shut down by core and owned exporters close only after run quiescence/final
  delivery.

Verification:

- 12 focused source suites pass 128 tests across filesystem, MCP HTTP/stdio/tool
  sources, exporter preflight/lifecycle/runtime close, Fetch, JSONL and OTel;
- a real-declaration additive compile journey covers complete filesystem scan/I/O,
  MCP connect/reconnect/catalog/result, IndexedDB quota/open, Fetch retry/batch/
  acknowledgment, JSONL retention/sync, OTel, and injected host-function options;
- packed Node fixtures pass for filesystem skills, MCP stdio and JSONL;
- packed Universal matrices pass for MCP HTTP, Fetch and OTel in standards-only
  Node, Chromium and workerd;
- the packed Browser fixture proves crash recovery, capacity/eviction, audit
  durability, lifecycle flushing and combined runtime OTel+IndexedDB terminal
  persistence/acknowledgment;
- a packed missing-peer probe fails with the exact required
  `@opentelemetry/api` name, while the same Browser consumer runs without the
  optional `@opentelemetry/api-logs` package.
