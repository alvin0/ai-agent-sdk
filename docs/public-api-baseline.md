# Pre-monorepo Public API Baseline

Status: frozen before package extraction  
Machine snapshot: [`../tests/fixtures/public-api/baseline.json`](../tests/fixtures/public-api/baseline.json)

The baseline records all 11 runtime entry points, their sorted JavaScript export names, and SHA-256 hashes of the emitted declaration entry files. The contract test rebuilds the package and compares the packed-facing entries with this snapshot.

Stable error-code families are recorded separately for model, model registry, tool, tool registry, observation, and provider-plugin failures. Standalone credential/context/empty-response codes are included as well. JSON persistence formats currently use schema version 1 for `HistorySnapshot`, `AgentMemorySnapshot`, and `AgentSessionSnapshot`.

Intentional migration changes are limited to those documented by the implementation design:

- `apiKeyFromEnv` leaves the Universal root and remains as a deprecated alias in `@ai-agent-sdk/auth-node` and `@ai-agent-sdk/node`;
- `TurnOutcome.usage` becomes optional and authoritative-only, while `usageReport` becomes required;
- streaming APIs gain stable handle/report properties without losing async iteration;
- legacy subpath names remain, but leaf packages become explicit optional peer installations.

Every other removed/renamed export or declaration-hash change must be explained in the migration record before the baseline is updated. Updating the JSON snapshot merely to make a failing test green is forbidden.

## C1 migration record — observation and provider-plugin contracts

The C1 snapshot update is intentionally additive at runtime. The root entry adds the Web-standard observation identities/events/port, usage accounting helpers and reports, `ModelCallObservationError`, provider-plugin contracts/errors, and no-op/core observation helpers. No pre-C1 runtime export is removed or renamed.

The following declaration changes are intentional:

- `ModelRegistry.stream()` and prepared-call `stream()` now return `ModelCallHandle`, which remains an `AsyncIterable<StreamChunk>` and adds stable `runId`, `modelCallId`, and `report` properties;
- registry, prepared-call, middleware, and adapter dispatch signatures accept the optional explicit `ModelInvocationContext` needed by browser and Edge runtimes without `AsyncLocalStorage`;
- `ModelRegistryOptions` accepts a default observation port and safe resource identity;
- `ModelRegistry.install()` accepts a transactional `ModelProviderPlugin` and returns its idempotent registration handle;
- provider, A2A, MCP, and request-logger declaration entry hashes change transitively because their emitted declarations reference the shared adapter/registry types. Their JavaScript export sets are unchanged.

Machine-baseline schema version 2 adds the stable observation and provider-plugin error-code families. The C1 comparison found no removed runtime symbol in any of the 11 frozen entries.

## C2 migration record — extracted Universal core

The C2 snapshot update changes source ownership from the root bundle to the workspace dependency `@ai-agent-sdk/core@0.1.0`. The compatibility root re-exports that package and retains SSE framing locally until `@ai-agent-sdk/provider-http` takes ownership in P0. Runtime export comparison found no removed or renamed symbol in any frozen entry.

Two inward primitives become additive root exports because workspace consumers must use a public core contract rather than bypass package exports: `detachedFrozen` and `waitForSettlement`. Declaration hashes change wherever emitted types now import shared contracts from `@ai-agent-sdk/core`; this is the intended package boundary, not a semantic removal. `./skill-filesystem` keeps its declaration hash because its public declaration does not reference a moved core type.

The packed `@ai-agent-sdk/core` surface is ESM-only with only `.` and `./package.json` exports. It has zero runtime dependencies and was installed from its tarball in independent standards-only, Cloudflare Worker, Chromium, and Node consumers before this baseline was accepted.

## A0 migration record — local team ownership

A0 moves the local collaboration implementation from `agent/a2a` to `agent/team`; the official A2A wire client/server remains under the distinct top-level `a2a` ownership. All existing runtime names (`AgentTeam`, `DefinedAgentTeam`, `ManagedAgentTeam`, and their factories) retain identity and behavior. The old source barrel remains as a deprecated identity-preserving re-export until 1.0.0.

The root runtime export set is unchanged. Declaration hashes change for the root and the A2A/MCP entries that transitively expose `AgentSessionOptions`: its team option now consumes a structural session-facing port, while `TeamSessionPort`, `TeamPort`, and `TeamMemberAttachmentOptions` are additive type-only exports. No JavaScript symbol was removed or renamed.

## A1 migration record — canonical run accounting

A1 intentionally changes the agent invocation contract described in the frozen exceptions above. `TurnOutcome.usageReport` is now required and coverage-aware; the legacy `usage` projection is optional and appears only when every possibly billed model call has authoritative counters. `AgentSession.stream()` and `streamPending()` remain single-consumer async iterables and now return `AgentRunHandle`, adding eager `result` and independently resolving `report` promises. `AgentResponse.report` is required and is the same frozen `RunReport` object exposed by the handle.

The root runtime additions are additive: `AGENT_ACCOUNTING_ERROR_CODES`, `AgentRunError`, `authoritativeTokenUsage`, `budgetTokenTotal`, and `summarizeModelCallUsage`. The core observation helpers `createObservationRunScope`, `snapshotObservationSpan`, and `validateCaptureReceipt` also become additive root exports because the extracted agent package must compose one explicit Web-standard sequence/correlation scope without importing core internals. No existing runtime symbol is removed or renamed.

Declaration hashes change transitively for entries that expose `AgentSession`, adapter invocation context, or the compatibility root. The new session options add observation resource/port, usage policy, and ledger limits; failures after run creation expose a finalized support-safe report through `AgentRunError`. Machine-baseline schema version 3 adds the stable agent-accounting error-code family.

## A2 migration record — extracted Universal agent

A2 moves canonical agent ownership to `@ai-agent-sdk/agent@0.1.0`. The root compatibility entry now re-exports the package instead of bundling a second implementation; A2A and MCP compatibility code imports the same package identity. Runtime export comparison found no added, removed, or renamed root symbol.

Declaration hashes change for the root and the A2A, MCP, and filesystem entries because their public declarations now reference `@ai-agent-sdk/agent` rather than root-private declaration chunks. `CompactionBackoffReason` moves to the inward history contract to remove the last history↔loop type-only source cycle, while the loop barrel preserves its existing type export. The Node-only filesystem implementation stays outside the Universal package and consumes the narrow exported `@ai-agent-sdk/agent/skill-validation` support subpath.

The packed agent manifest has one runtime dependency, `@ai-agent-sdk/core`, and no Node builtin/global usage in its source or emitted closure. Its tarball passed independent standards-only, Chromium, and Cloudflare Worker installs with mock provider, tool, team, run-accounting, and manual-compaction flows before this baseline was accepted.

## I1 migration record — extracted Node-elevated A2A bridge

I1 moves the official A2A protocol client/server bridge to `@ai-agent-sdk/a2a@0.1.0`. The legacy `ai-agent-sdk/a2a-client` and `ai-agent-sdk/a2a-server` entries remain identity-preserving re-exports of the package `/client` and `/server` subpaths. Their runtime export sets are unchanged; only their declaration hashes change because the declarations now point at the canonical package.

The package is intentionally classified as Node-elevated. Packed Node tests cover text, structured data, URLs, and raw binary serialization. A strict Worker fixture proves text remains usable without Node globals but records raw binary failure at the upstream `@a2a-js/sdk@1.1.0` `Buffer.from` boundary as a labelled negative promotion guard. If that guard starts passing, the package runtime classification must be reviewed rather than silently changed.

## P0 migration record — extracted Universal HTTP provider

P0 moves fetch dispatch, HTTP errors, configurable provider construction, the wire-protocol contract, and SSE framing to `@ai-agent-sdk/provider-http@0.1.0`. Root, Anthropic, OpenAI, Codex, and request-logger declaration hashes change because their public types now reference the package-owned transport contracts. Runtime export comparison found no added, removed, or renamed root symbol, and compatibility identity tests prove the root uses the same `HttpModelAdapter`, `createHttpProvider`, `parseSse`, and `resolveDialect` values as the package.

The Universal package accepts literal or injected credential resolvers and contains no environment/file lookup. The deprecated root `apiKeyFromEnv` bridge remains Node-owned until `@ai-agent-sdk/auth-node` replaces it. Exact wire request logging remains one explicitly deprecated, high-risk compatibility hook; structured provider-attempt observation is the default support path and records only safe origin metadata, dispatch state, status, request ID, coverage, and sanitized errors.

The packed manifest owns exact `eventsource-parser@4.1.0` and no other package declares it directly. A conformance test found that parser overflow is delivered through `onError`; the SDK wrapper now turns only `max-buffer-size-exceeded` into an immediate attempt failure while preserving SSE's forward-compatible unknown-field behavior. Packed standards-only Node, Chromium, and Cloudflare Worker fixtures prove the emitted closure needs neither Node globals nor builtins.

## P1 migration record — extracted Universal wire protocols

P1 moves the Anthropic Messages and shared Responses/Codex wire schemas,
serializers, translators, and dialects to
`@ai-agent-sdk/protocol-anthropic-messages@0.1.0` and
`@ai-agent-sdk/protocol-responses@0.1.0`. The root, `./anthropic`, and `./openai`
declaration hashes change because their public protocol types now reference the
canonical workspace packages. Their runtime export sets are unchanged, and
identity tests prove every compatibility entry re-exports the same frozen
protocol objects as the package entry points.

Each protocol has only `@ai-agent-sdk/core` as a runtime dependency. A structural
request/SSE contract keeps transport concerns out of the packages; provider
adapters import only their public exports. Protocol translators may surface an
internal partial or malformed `UsageCounters` report to `provider-http`, which
validates and retains it on the physical attempt. Only a complete, valid report
is emitted as public `TokenUsage`, preserving its exact-report contract. This is
an intentional declaration-only addition; no runtime symbol is removed or
renamed. Packed standards-only Node, Chromium, and Cloudflare Worker fixtures
prove both emitted protocol closures need neither Node globals nor builtins.

## P2 migration record — extracted Universal providers

P2 moves canonical Anthropic, OpenAI, and Codex adapter ownership to
`@ai-agent-sdk/provider-anthropic`, `@ai-agent-sdk/provider-openai`, and
`@ai-agent-sdk/provider-codex`. Each package adds a preferred transactional
plugin factory beside its low-level adapter. The compatibility `./anthropic`,
`./openai`, and `./codex` entries therefore gain one additive runtime export:
`anthropicPlugin`, `openAiPlugin`, and `codexPlugin`; no existing symbol is
removed or renamed.

The Universal Anthropic/OpenAI adapters require an injected API key source, and
the Universal Codex adapter requires an injected `CodexAuthStore`. Environment,
path, and filesystem defaults remain only in the root Node compatibility
wrappers until `@ai-agent-sdk/auth-node` assumes ownership in N0. Declaration
hashes change for the root and provider compatibility entries because they now
reference the canonical provider packages and `ModelInvocationContext` carries
the safe observation resource needed by nested credential/catalog spans.

Credential resolve/refresh and model-catalog discovery emit structured operation
events with provider/operation/safe origin only. Token values, account details,
credential labels and store locations are excluded even on failures. All three
provider tarballs execute in standards-only Node, Chromium, and Cloudflare Worker
without Node globals or builtins.

## O0 migration record — Universal observability bus

O0 adds the leaf package `@ai-agent-sdk/observability@0.1.0`; it does not change
the compatibility root runtime or any of its frozen subpath exports. The package
implements the core `ObservationPort` contract with bounded priority queues,
ordered synchronous transforms, honest required/best-effort durability,
checkpoint/flush/shutdown lifecycle, health snapshots, scoped structured logs,
privacy processing, backend-neutral projections, and memory/fault-injection
exporters.

Privacy processing runs both before and after user transforms, so a transform
cannot reintroduce content or credential fields. Reliable/audit construction
requires an exporter that explicitly declares a non-memory durability boundary;
the memory exporter supports only `none`. The packed package has only
`@ai-agent-sdk/core` as a runtime dependency and passes standards-only Node,
Chromium, and Cloudflare Worker fixtures without Node globals or builtins.

## O1 migration record — acknowledged Universal Fetch exporter

O1 adds the leaf package `@ai-agent-sdk/observability-fetch@0.1.0`; it does not
change any frozen compatibility-root runtime export or declaration. The package
depends inward on the public core and observability contracts and exports only
`FetchObservationExporter`, `flushObservabilityWithWaitUntil`, and their option
types. Remote durability is claimed only after HTTP 204 or an exact matching
JSON batch acknowledgment. Host lifecycle extension remains explicit, so no
Edge platform global is added to the Universal dependency closure.

## O2 migration record — Browser IndexedDB durability

O2 adds `@ai-agent-sdk/observability-browser@0.1.0` without adding IndexedDB or
page lifecycle code to the compatibility root, core, agent, or Edge packages.
The concrete observability export contract gains one additive optional
`stage(event)` hook. The Universal bus invokes it after privacy/capacity
acceptance so Browser and later Node durability backends can begin local staging
during capture; existing exporters that omit it retain their identity and
behavior.

The Browser leaf exposes `IndexedDbObservationExporter`, explicit recovery and
acknowledgment methods, stable browser quota/unavailable errors, and an opt-in
lifecycle installer. It claims only `local-durable`, after transaction commit.
No frozen root runtime symbol is added, removed, or renamed.

## O3 migration record — Node journal and gated wire diagnostics

O3 adds the Node-only `@ai-agent-sdk/observability-node@0.1.0` leaf with separate
`/journal` and `/diagnostic` capability entries. Its append-only journal claims
`local-durable` only after `fdatasync`, uses private unique per-process segments,
checksum framing, atomic acknowledgment cursors, acknowledged-only retention,
and explicit recovery. Importing the package installs no process hooks.

The frozen compatibility `./request-logger` JavaScript export set is unchanged.
Its declaration hash changes intentionally because exact provider bodies now
require both `content: 'full'` and `allowWireBodies: true`; the returned logger
also exposes `shutdown()` so callers can sync and close its private unique wire
files. The former `calendar` option remains as a deprecated type-only no-op, so
no named runtime export is removed or renamed. Structured observation remains
the default support path, and the human harness keeps exact-wire logging off
unless `--logs` is supplied explicitly.

## O4 migration record — caller-owned OpenTelemetry bridge

O4 adds the Universal leaf `@ai-agent-sdk/observability-otel@0.1.0` without
changing a frozen compatibility-root runtime export. It accepts caller-owned
`Tracer`, `Meter`, and optional structural logger objects; installs no global
provider, SDK, exporter, or network path. The optional logs peer therefore does
not become mandatory for trace-and-metric consumers.

Actual tracer spans are opened synchronously and their valid IDs become SDK
correlation IDs. A bridge-owned explicit context map preserves the
run→logical-model→provider-attempt hierarchy, including retry siblings, without
ambient context or AsyncLocalStorage. Core backend-span validation now accepts
the full two-hex-digit W3C trace-flags field, so an unsampled `-00` traceparent
is retained rather than rejected and replaced with a second identity.

The mapping fixture is pinned to semantic-conventions commit
`5ca9052bc796ef1e497200b1d558fd87a201f335`. Provider-reported input includes
uncached, cache-read, and cache-write counters; estimated usage remains on the
SDK metric with an explicit source and never impersonates semantic provider
usage. Prompt/completion span attributes require `content: 'full'` on both the
privacy bus and bridge. Invalid/no-op contexts degrade safely with
`OTEL_PROVIDER_UNCONFIGURED`; synchronous API failures are observable without
copying arbitrary exporter messages or content into health diagnostics.

## I0 migration record — Universal MCP HTTP package

I0 moves the canonical fetch-shaped MCP client/server bridge to
`@ai-agent-sdk/mcp@0.1.0`, with separate `/client` and `/server` capability
entries. The compatibility `./mcp-client` and `./mcp-server` entries statically
re-export those package objects, and identity tests prove they do not bundle a
second `McpClientConnection` or server implementation. Their declaration
hashes—and the transitive `./mcp-node` hash—change only because public types now
reference the package-owned contracts. All three frozen runtime export sets are
unchanged.

The package directly owns `@modelcontextprotocol/client@2.0.0` and
`@modelcontextprotocol/server@2.0.0`; stdio, child processes, `node:http`, and
host lifecycle adapters remain outside it. A packed standards import plus real
Chromium and strict Cloudflare Worker round-trip exercise legacy initialize,
tool discovery/call, abort, invalid bearer state, and catalog bounds. The
Worker and browser execute with `Buffer` and `process` unavailable.

That runtime gate found an upstream boundary incompatibility hidden by Node:
the Worker/browser JSON Schema validator attaches dereference metadata, while
SDK tool schemas are frozen. The bridge now passes a `structuredClone` to the
protocol validator, preserving canonical schema immutability while allowing the
upstream validator to operate on its private copy.

## N0 migration record — granular Node capabilities

N0 moves filesystem skill discovery, MCP stdio/Node HTTP adapters, environment credentials, and the project-local Codex file wrapper to `@ai-agent-sdk/skill-filesystem`, `@ai-agent-sdk/mcp-node`, and `@ai-agent-sdk/auth-node`. The legacy `./skill-filesystem`, `./mcp-node`, and `./codex` entries are identity-preserving package re-exports with exactly their existing runtime export sets. The compatibility root still retains `apiKeyFromEnv` until the documented K0 root-boundary migration, but it now points at the same `auth-node/env` function.

Declaration hashes change only for the root and the three moved Node entries because emitted types now reference their canonical packages. `auth-node` adds the preferred `envCredential`, `codexNodeAdapter`, and `codexNodePlugin` names on its own package surface without adding them to the frozen legacy entries. Its Codex store resolves relative paths against an explicit/default working directory, never defaults to the Codex CLI global file, rejects credential-file symlinks, bounds reads, and commits through a private unique same-directory temporary file, file sync, atomic rename, `0600` target mode, and directory sync. Packed consumers execute that store and built login CLI, lazy filesystem discovery, and a real MCP stdio child/tool call.

## N1 migration record — batteries-included Node facade

N1 adds `@ai-agent-sdk/node@0.1.0` without changing any frozen compatibility entry. Its root and documented capability subpaths are re-export-only and preserve leaf-package identities; MCP and A2A are namespaced at the main entry to avoid ambiguous protocol types while remaining fully available through `/mcp` and `/a2a`. The facade excludes `@ai-agent-sdk/observability-browser` from both source and manifest, while `/observability` includes the Universal bus/fetch/OTel layers and Node journal.

The default `codexAdapter`/`codexPlugin` and preferred `codexNodeAdapter`/`codexNodePlugin` all come from `auth-node`, so an omitted store resolves only the project-local `.providers/.codex/auth.json`; the injected-store Universal provider remains explicit under the `universalCodex` namespace. A packed full-harness consumer proves one canonical core identity across the facade, filesystem skill discovery, a mock provider run with durable correlated journal events, and an MCP stdio child/tool call. No public compatibility baseline hash changes in N1.

## K0 migration record — compatibility package cutover

K0 moves the unscoped `ai-agent-sdk` package manifest, export map, and compatibility shims to `packages/sdk`; the repository root becomes private orchestration. The frozen eleven legacy entry paths retain exactly their runtime export sets except for the one design-approved removal of `apiKeyFromEnv` from `.`. That deprecated alias remains available from `@ai-agent-sdk/auth-node/env`, `@ai-agent-sdk/auth-node`, `@ai-agent-sdk/node/env`, and `@ai-agent-sdk/node`. The only added compatibility path is `./node`.

Four declaration hashes change intentionally and are locked explicitly by the contract fixture:

- `.` removes the Node environment reader and now declares only direct Universal package-owned types;
- `./anthropic` and `./openai` re-export their Universal providers, making injected `apiKey` mandatory instead of silently reading `process.env`;
- `./request-logger` retains the same runtime and callable shape while its declarations reference the public provider-http contract instead of a compatibility package-private declaration chunk.

The Codex, A2A, MCP, filesystem, and every other legacy declaration entry remain byte-identical to the frozen hashes. The Codex shim uses an explicit list so the preferred `codexNodeAdapter`/`codexNodePlugin` names remain at their new owners without accidentally expanding the legacy path.

The compatibility manifest has regular dependencies only on core, agent, provider-http, and the two protocol packages. Provider, auth, integration, diagnostic, and full-Node leaf targets are optional peers with exact install commands in the package README. A tarball root-only installation runs with Node globals removed and contains no Node-only leaf; a separate all-peer tarball installation executes every legacy path, verifies canonical object identity, and resolves all type-only entries.
