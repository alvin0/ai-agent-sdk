# `@alvin0/ai-agent-sdk-testkit`

Runtime: **Universal** — development dependency only.

Framework-independent, dev-only conformance suites for capability authors.

> **Status.** The package is currently **private** and is exercised through local
> workspace or tarball installs; publishing is intentionally not configured.
>
> ```bash
> pnpm add -D ./artifacts/alvin0-ai-agent-sdk-testkit-0.1.2.tgz
> ```

## Exports

```ts
export {
  runProviderConformanceSuite,
  ProviderConformanceError,
}

export type {
  ProviderConformanceCase,
  ProviderConformanceCaseInput,
  ProviderConformanceCheck,
  ProviderConformanceCheckId,
  ProviderConformanceControl,
  ProviderConformanceControlSnapshot,
  ProviderConformanceFixture,
  ProviderConformanceOptions,
  ProviderConformanceReport,
  ProviderConformanceScenario,
}
```

## Running the suite

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'

const report = await runProviderConformanceSuite(fixture)
```

It returns a **frozen structured report**, and throws `ProviderConformanceError`
carrying that same report when any check fails — so Vitest, `node:test`, or any
other harness can use it without an adapter dependency.

## What it checks

`runProviderConformanceSuite(fixture)` drives a fresh provider fixture through:

| Area | Checks |
| --- | --- |
| Registration | Marker preflight, route conflicts, rollback |
| Execution | Streaming, usage reporting, retries, cancellation |
| Catalog | Discovery and snapshot behaviour |
| Failure | Bounded-stream failure |
| Observation | Privacy and correlation |
| Cleanup | Cleanup-failure containment, idempotent cleanup |

## Writing a fixture

The fixture factory receives a **scenario, plugin ID, and route**. It must
return:

- an inert `ComposableModelProviderPlugin`;
- the explicit model ID;
- lifecycle counters;
- an in-flight dispatch barrier for the cancellation scenario.

```ts
const fixture: ProviderConformanceFixture = ({ scenario, pluginId, route }) => ({
  plugin: myProviderPlugin({ /* … */ }),
  modelId: 'test-model',
  counters,
  barrier,
})
```

> **Never** place provider credentials, endpoints, or raw failures in the control
> snapshot or the report.

## Read next

- [Custom Provider](/en/09-providers/custom-provider)
- [Testing and acceptance](/en/14-project/testing)
