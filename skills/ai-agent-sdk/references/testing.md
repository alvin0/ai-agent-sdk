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

Writing a provider, embedding provider, credential source, tool source, skill
provider, memory store, or exporter? `@alvin0/ai-agent-sdk-testkit` drives a
fixture through the contract instead of leaving you to guess it.

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

### Copilot: one contract, two endpoints

Copilot is the one provider in the repository whose single route dispatches to
**two different wire protocols** — `/responses` for some models,
`/chat/completions` for the rest. The risk is not that one branch is broken, it
is that the two **diverge**: one serializes `input`, the other `messages`; one
reports usage on the terminal event, the other on a trailing chunk with no
choices.

So the generation scenario set runs **twice, sharing every assertion**. Only two
things differ per pass: the endpoint the router is pinned to, and the frames that
endpoint speaks.

```ts
import {
  COPILOT_GENERATION_RUNS,
  withCopilotTokenExchange,
} from '@alvin0/ai-agent-sdk-testkit'

for (const run of COPILOT_GENERATION_RUNS) {
  const report = await runProviderConformanceSuite(fixtureFor(run), { caseTimeoutMs: 2_000 })
  expect(report).toMatchObject({ schemaVersion: 1, status: 'passed', passed: 19, failed: 0 })
}
```

| Export | What it supplies |
| --- | --- |
| `COPILOT_GENERATION_RUNS` | The two passes, `/responses` first, each with `endpointOverrides`, `model`, and `frames` |
| `COPILOT_RESPONSES_FRAMES`, `COPILOT_CHAT_COMPLETIONS_FRAMES` | Stream frames for each endpoint's shape |
| `withCopilotTokenExchange(inner)` | Answers `copilot_internal/v2/token` locally, delegates everything else |
| `COPILOT_CONFORMANCE_REGISTRY` | The named scenario groups, reachable as `PROVIDER_CONFORMANCE_REGISTRY.copilot` |

Three details that are load-bearing:

- **The endpoint is pinned with `endpointOverrides`, not chosen by model id.** A
  run must not depend on a prefix allowlist or a catalog disclosure — both are
  facts about a remote endpoint that will change. The override is the one input
  in the router's decision order the test owns. Both passes state it explicitly,
  including the one that matches the router default: a pass relying on the
  default would still be green if the default moved, while claiming to have
  tested the endpoint it named.
- **`withCopilotTokenExchange` wraps the fixture's scripted fetch rather than
  replacing it.** Copilot holds a long-lived GitHub token and has to trade it for
  a short-lived API token at a *different origin* before any generation request
  goes out. A scripted fetch written for the generation leg alone never sees that
  first request. The wrapper answers it locally and delegates the rest unchanged,
  so the exchange never touches the fixture's dispatch counters — which is what
  keeps the retry and cancellation scenarios counting only generation attempts.
- **The report shape is unchanged.** No new check id, no new report field, no
  `schemaVersion` bump — Copilot fixtures are added data, not a new report shape.
  That is precisely the property that makes the two passes comparable to each
  other at all, and the suite asserts it: identical check-id/status lists,
  identical `schemaVersion`, identical top-level keys.

Nothing under `testkit/src/provider/copilot/` imports `provider-copilot`, and
nothing can — the testkit's only workspace dependency is `core`, and inverting
that would make the package that validates providers depend on one of them. The
adapter is injected by the caller; the testkit supplies frames, endpoint pins,
and the exchange responder.

### Embedding: sixteen checks over twelve scenarios

An embedding provider has its own entry point, because a fixture that scripts
`data[i].index` has nothing in common with one that scripts a stream:

```ts
import {
  runEmbeddingConformanceSuite,
  EMBEDDING_CONFORMANCE_SCENARIOS,   // the twelve, as data
  EMBEDDING_CONFORMANCE_CHECK_IDS,   // the sixteen, in report order
} from '@alvin0/ai-agent-sdk-testkit'

const report = await runEmbeddingConformanceSuite(fixture, { caseTimeoutMs: 2_000 })
expect(report).toMatchObject({ schemaVersion: 1, status: 'passed', passed: 16, failed: 0 })
```

**The report shape is unchanged.** Embedding results are
`ProviderConformanceCheck`es in the same `checks` array of the same
`ProviderConformanceReport`, and `schemaVersion` stays `1`. A capability that
needed its own report shape would not be conforming to the same contract as the
others. Like the generation runner, a failing check is recorded with a
support-safe message and the remaining checks still run, so one report explains
everything that is wrong rather than the first thing.

The sixteen ids group exactly as the nine contract-test groups:

| Group | Check ids |
| --- | --- |
| Mapping and validation | `embedding-mapping-index-faithful`, `embedding-mapping-invalid-rejected`, `embedding-vector-validation` |
| Batching | `embedding-batch-limits-respected`, `embedding-batch-memory-bounded` |
| Cancellation and close | `embedding-abort-stops-unsent`, `embedding-close-covers-operation` |
| Retry cost | `embedding-retry-no-resend`, `embedding-timeout-dispatch-unknown` |
| Cache | `embedding-cache-key-composition` |
| Compatibility | `embedding-space-guard`, `embedding-no-model-fallback` |
| Plugin compatibility | `embedding-plugin-generation-only`, `embedding-plugin-embedding-only` |
| Privacy | `embedding-trace-privacy` |
| Usage honesty | `embedding-usage-honesty` |

The scenarios are `embedding-success`, `embedding-reordered-response`,
`embedding-invalid-index`, `embedding-invalid-vector`, `embedding-batch-limits`,
`embedding-abort-in-flight`, `embedding-retry-cost`,
`embedding-missing-usage`, `embedding-cache-key`, `embedding-space-mismatch`,
`embedding-only-runtime` and `generation-only-plugin` — the last of which hands
over a `model-provider-plugin` on purpose, since the claim being checked is that
the two kinds do not stand in for each other.

Three things about the split of labour are load-bearing:

- **The runner knows no endpoint, and owns the corpus.** Every provider-specific
  fact — the plugin, the model id, the scripted response, the declared batch
  bounds, the expected error code — arrives through
  `EmbeddingConformanceFixture.create()`, which is handed the exact texts to
  embed. Holding both providers to the same inputs is what makes "the same error
  codes on both" a checkable claim. It also gives the privacy check something it
  *knows* must never appear in a trace: every input carries
  `EMBEDDING_CONFORMANCE_DEFAULTS.contentSentinel`, so "the trace carries no raw
  document content" is a substring test rather than an inspection.
- **Index fidelity is checked against the provider's output, not the SDK's.**
  `control.providerVectors()` reports what the provider returned per item index,
  before any post-processing the profile records, and the harness compares
  element-wise with what the SDK published. Comparing the SDK's result against
  the SDK's result agrees even under a permutation.
- **Abort is a fact, not a race.** `control.waitForDispatch()` resolves once the
  fixture has entered its first dispatch, so "abort while a batch is on the wire"
  is arranged rather than hoped for. The batching scenarios likewise must declare
  `maxItems` below `inputs.length`: a case that fits in one batch exercises no
  bound and proves nothing about memory.

`EmbeddingConformanceControlSnapshot` is where a fixture reports what it actually
served — one `dispatches` entry per `Provider_Attempt` with its model id, item
indexes and payload bytes, plus `peakInFlight` and `peakInFlightBytes`. The model
id is how `embedding-no-model-fallback` is checked: a silent fallback shows up as
a different value.

> **Four Copilot-specific scenario groups are still pending** — model-driven
> endpoint selection, missing editor headers, credential rejection at exchange,
> and proactive refresh before expiry. `COPILOT_CONFORMANCE_REGISTRY` is a record
> rather than a bare array so those groups can be asked for by name when they
> land; today it has one key, `generation`.

**The testkit is a private package** — it is a devDependency of the provider
packages and is not published to npm. Consume it from a workspace or a local
tarball:

```bash
pnpm add -D ./artifacts/alvin0-ai-agent-sdk-testkit-0.1.2.tgz
```

## Runtime-tier checks

If you publish a Universal package on top of this SDK, test it the way the SDK
tests itself: pack the tarball and import it in the target runtime. A Node
built-in that sneaks into a Universal package fails at the edge, not in your
unit tests.

## Live Copilot embedding probe

`pnpm provider:copilot:embedding` is an opt-in integration test against the real
Copilot `/embeddings` endpoint. It discovers the embedding models available to
the signed-in account, then checks response shape, index fidelity, optional
dimension handling, and semantic similarity. It spends remote quota and is
excluded from the normal Vitest suite.

This probe uses raw HTTP after the Copilot token exchange. It is evidence about
the endpoint, not an SDK embedding adapter: there is no
`copilotEmbeddingPlugin`, and `runtime.embeddingModel({ provider: 'copilot',
... })` is not supported. Use `openAiEmbeddingPlugin()` or
`geminiEmbeddingPlugin()` for embedding through the runtime.

## Repository CI and release gate

The current workspace release line is `0.1.2`. Every
`packages/*/package.json`, including the private testkit, must carry the same
version before release. The Release workflow packs only non-private packages.

For a local equivalent of the PR CI gates, run:

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm workspace:typecheck
pnpm build:cli
pnpm lint
pnpm exec tsc --noEmit
pnpm check:boundary-fixtures
pnpm exec vitest run
pnpm test:packages
pnpm test:pack
pnpm check:supply-chain
```

Keep documentation and recorded protocol evidence separate from those three CI
jobs and validate them when they changed:

```bash
pnpm check:docs
pnpm oracle:generation:check
npm --prefix web-documents run build
```

`.github/workflows/release.yml` runs on every push to `main`, on `v*` tags, and
by manual dispatch. A manual dispatch is a dry run by default; a push publishes
after the build, boundary, type, functional, package, supply-chain, lockstep,
and packed-dependency checks pass. A version already present on npm is skipped,
so a partially completed release can be retried without republishing the
successful packages. A tag must equal the core package version.

Local success proves only the checkout. Do not report a release as complete
until the hosted Release workflow succeeds and the expected package versions
are observable on npm.
