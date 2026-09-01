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
