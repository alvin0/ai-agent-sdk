# I3 integration logging evidence

Date: 2026-09-05

## Optional logger surfaces

The preserved MCP client lifecycle options now accept `logger?: SdkLogger`, so
both HTTP and inherited Node stdio clients share the same optional surface.
`SdkMcpServerOptions` carries the same optional logger for Web and Node stdio
hosting. A2A link and defined-agent executor/server options already carry the
optional canonical logger type. No integration constructs a console sink when
the property is absent; existing direct standalone tests continue to run without
supplying a logger.

The recommended target consumers create `AgentRuntime` first and pass a bound
child logger into MCP/A2A connection or serving options. Current direct advanced
construction remains supported. Core now exports the canonical
`IntegrationOperationEvidenceFields` type from its observability subpath for the
subsequent active-operation instrumentation slice.

Verification: strict core, MCP, MCP Node and A2A typechecks pass; core and MCP
builds pass; the strict workspace TypeScript compile passes.

## Runtime-active operation matrix and completeness

The six first-party integration families now emit the frozen 27-operation
matrix. MCP HTTP/stdio lifecycle work uses the connection logger, MCP tool calls
use the runtime tool-context logger, A2A link/card work uses the link logger,
and runtime teams inject the active logger into linked send/stream calls. Web and
stdio server request scopes are child loggers; callers cannot provide operation,
attempt, run, trace, or span identities.

Every emitted field object is statically typed as
`IntegrationOperationEvidenceFields` from `core/observability`. Runtime enqueue
validates the schema marker, 64-character family/operation limits,
128-character operation/attempt/error-code limits, one-based attempts, terminal
status, and finite non-negative duration. Start/success/abort use `info`; failure
uses `error`. Error-code projection is accessor-safe and bounded, and never
copies credentials, headers, bodies, prompts, results, or agent-card content.

Core wraps provider setup, credential resolve/read/commit, tool-source snapshot,
skill list/load/resource and memory load/commit even when capability code logs
nothing. These logs use the same privacy processor, bounded queue, health and
exporter path as application logs. Exporters never receive a logger, preventing
delivery recursion.

The runtime health projection counts accepted, filtered, dropped and rejected
integration evidence with saturating counters. Completeness requires exact
logical/attempt cardinality and pairing, event-ID acknowledgments and independent
cleanup reports. Missing expectations/acknowledgments, counter overflow or an
evicted diagnostic view remain `unknown`; filtering, queue loss, rejection,
unbalanced pairs, incomplete acknowledgment or failed cleanup are `incomplete`.
Synchronous `SdkLogger` methods return `void` and are never token, billing,
durability or acknowledgment evidence.

Post-runtime cleanup remains independently inspectable through idempotent,
support-safe `McpCloseReport`, `McpNodeServerCloseReport`, `A2AUnlinkReport` and
`A2ADisposeReport`. Compatibility `close`/`unlink`/`dispose` methods remain, and
transactional MCP construction preserves the primary connect failure while
attaching bounded cleanup evidence.

## Capture and mutation boundary

Provider, exporter, credential source/store, tool source and generated tools,
skill provider, memory store, local tools and policy leaves all create private
captured handles before executable use. Markers, identities, detached bounded
configuration and method references are read once; methods retain their original
receiver. Caller-owned objects remain unfrozen, while later method replacement,
deletion or getter mutation cannot redirect work or cleanup. The provider HTTP
runtime additionally snapshots callback/static option surfaces, and Codex
captures both legacy and revision-aware credential store methods before I/O.

## Verification update — 2026-09-05

- 176 tests across 14 integration/capability/logging/capture suites passed.
- 207 accounting, provider-attempt, retry, compaction, delivery and run-ledger
  tests across 10 suites passed.
- All 11 migrated capability tarball matrices passed after removing deprecated
  agent/observability facades from their consumer fixtures.
