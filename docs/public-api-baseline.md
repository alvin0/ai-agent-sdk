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
