# Pre-monorepo Public API Baseline

Status: frozen before package extraction  
Machine snapshot: [`../tests/fixtures/public-api/baseline.json`](../tests/fixtures/public-api/baseline.json)

The baseline records all 11 runtime entry points, their sorted JavaScript export names, and SHA-256 hashes of the emitted declaration entry files. The contract test rebuilds the package and compares the packed-facing entries with this snapshot.

Stable error-code families are recorded separately for model, model registry, tool, and tool registry failures. Standalone credential/context/empty-response codes are included as well. JSON persistence formats currently use schema version 1 for `HistorySnapshot`, `AgentMemorySnapshot`, and `AgentSessionSnapshot`.

Intentional migration changes are limited to those documented by the implementation design:

- `apiKeyFromEnv` leaves the Universal root and remains as a deprecated alias in `@ai-agent-sdk/auth-node` and `@ai-agent-sdk/node`;
- `TurnOutcome.usage` becomes optional and authoritative-only, while `usageReport` becomes required;
- streaming APIs gain stable handle/report properties without losing async iteration;
- legacy subpath names remain, but leaf packages become explicit optional peer installations.

Every other removed/renamed export or declaration-hash change must be explained in the migration record before the baseline is updated. Updating the JSON snapshot merely to make a failing test green is forbidden.
