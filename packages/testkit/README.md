# @alvin0/ai-agent-sdk-testkit

Runtime: **Universal** (development dependency only)

Framework-independent, dev-only conformance suites for capability authors. The
package is currently private and is exercised through local workspace/tarball
installs; publishing is intentionally not configured.

Until registry publication is configured, install the locally packed artifact:

```sh
pnpm add -D ./artifacts/ai-agent-sdk-testkit-0.1.1.tgz
```

`runProviderConformanceSuite(fixture)` drives a fresh provider fixture through
marker preflight, route conflicts, rollback, streaming, usage, retries,
cancellation, catalog behavior, bounded-stream failure, observation
privacy/correlation, cleanup-failure containment and idempotent cleanup. It
returns a frozen structured report and throws
`ProviderConformanceError` with that same report when any check fails, so Vitest,
Node's test runner or another harness can use it without an adapter dependency.

The fixture factory receives a scenario, plugin ID and route. It must return an
inert `ComposableModelProviderPlugin`, the explicit model ID, lifecycle counters
and an in-flight dispatch barrier for the cancellation scenario. Provider
credentials, endpoints and raw failures must not be placed in the control
snapshot or report.
