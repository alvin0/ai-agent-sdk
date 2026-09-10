# Testing agents built on the SDK

Nothing here needs a live provider. The pieces that make an agent testable are
the same ones that make it observable.

## Fake the adapter, not the agent

`ModelRegistry.registerAdapter(routes, adapter)` accepts any `ModelAdapter`, so
a stub adapter that yields a scripted chunk sequence exercises the whole loop —
tools, budgets, compaction, events — with no network:

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'

const registry = new ModelRegistry()
registry.registerAdapter(['fake'], scriptedAdapter([
  { type: 'text-delta', text: 'Calling the tool' },
  { type: 'tool-call', id: 'call-1', name: 'multiply', arguments: '{"a":21,"b":2}' },
  { type: 'finish', reason: { kind: 'stop' } },
]))
```

Because `generate()` drains the same stream `stream()` exposes, one scripted
sequence covers both call styles.

## Assert on the report, not on prose

```ts
const response = await agent.generate('What is 21 * 2?')

expect(response.completed).toBe(true)
expect(response.stopReason).toBe('completed')
expect(response.report.status).toBe('success')
expect(response.report.operationCounts).toMatchObject({ /* tool/model counts */ })
expect(response.report.errors).toEqual([])
```

Assert `completed`/`stopReason` for objective completion and `report.status`
for execution status — they answer different questions, and only checking the
second is how a test passes on an agent that gave up early.

Token assertions should tolerate absence: a counter a provider did not report
is `undefined`, never `0`. Check `report.usage` coverage before asserting a
number.

## Capture observations in memory

```ts
import { createObservability, MemoryObservationExporter, TestObservationExporter } from '@alvin0/ai-agent-sdk-core/observability'

const exporter = new MemoryObservationExporter()
const observability = createObservability({
  exporters: [{ exporter, requirement: 'best-effort', boundary: 'none' }],
})

const registry = new ModelRegistry({ observation: observability })

await observability.flush()
expect(exporter.exported.flatMap(batch => batch.events).map(event => event.name))
  .toContain('sdk.tool.call')
```

`TestObservationExporter` adds fault injection — a configurable number of
failures, retryable or not, and ack rejection — for testing delivery paths:

```ts
const flaky = new TestObservationExporter({ /* failuresRemaining, retryable, rejectAck */ })
flaky.exported      // ObservationBatch[]
flaky.shutdownCalls // number
```

Neither exporter claims durability. Both are for tests and local inspection
**only**.

## Inspect the shape of a run

```ts
import { buildTraceTree } from '@alvin0/ai-agent-sdk-core/agent'

const spans = buildTraceTree(events)   // readonly AgentProcessSpan[]
```

Useful when the assertion is structural — "the reviewer ran before the lead
synthesized" — rather than about text.

## Close the runtime in every test

```ts
afterEach(async () => {
  const report = await runtime.close()
  expect(report.unsettledRuns).toBe(0)
})
```

`unsettledRuns > 0` means something ignored cancellation. A test suite that
asserts it catches an adapter or tool that leaks work between tests, which is
otherwise the hardest class of flake to trace.

## Conformance suite for capability authors

Writing a provider, credential source, tool source, skill provider, memory
store, or exporter? `@alvin0/ai-agent-sdk-testkit` drives a fixture through the
contract instead of leaving you to guess it.

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'

const report = await runProviderConformanceSuite(fixture, options)
```

It returns a **frozen structured report** and throws `ProviderConformanceError`
carrying that same report when a check fails — so Vitest, `node:test`, or any
harness works without an adapter dependency.

| Area | Checks |
| --- | --- |
| Registration | Marker preflight, route conflicts, rollback |
| Execution | Streaming, usage reporting, retries, cancellation |
| Catalog | Discovery and snapshot behaviour |
| Failure | Bounded-stream failure |
| Observation | Privacy and correlation |
| Cleanup | Cleanup-failure containment, idempotent cleanup |

The fixture factory receives a scenario, plugin id, and route, and returns an
inert `ComposableModelProviderPlugin`, the explicit model id, lifecycle
counters, and an in-flight dispatch barrier for the cancellation scenario.

**The testkit is a private package** — it is a devDependency of the provider
packages and is not published to npm. Consume it from a workspace or a local
tarball:

```bash
pnpm add -D ./artifacts/alvin0-ai-agent-sdk-testkit-0.1.0.tgz
```

## Runtime-tier checks

If you publish a Universal package on top of this SDK, test it the way the SDK
tests itself: pack the tarball and import it in the target runtime. A Node
built-in that sneaks into a Universal package fails at the edge, not in your
unit tests.
