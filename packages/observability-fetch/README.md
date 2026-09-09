# @alvin0/ai-agent-sdk-observability-fetch

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-observability-fetch
```

Universal acknowledged HTTPS exporter for `@alvin0/ai-agent-sdk-core/observability`. It sends
bounded JSON batches with an idempotency key and retries only the observation
batch—not the model/provider operation that produced it.

```ts
import { fetchObservationExporter } from '@alvin0/ai-agent-sdk-observability-fetch'

const exporter = fetchObservationExporter({
  endpoint: 'https://telemetry.example.com/v1/observations',
  headers: { authorization: `Bearer ${telemetryToken}` },
})
```

Use `flushObservabilityWithWaitUntil()` to hand a flush promise to an Edge host's
explicit `waitUntil` function. The package never assumes a platform global.

The exporter uses POST JSON with `idempotency-key: <batchId>`, a 10-second
request timeout, and batches capped at 256 events/512 KiB. It accepts HTTP 204
or `{ "acceptedBatchId": "<batchId>" }`. Network failures, 408, 425, 429, and
5xx responses retry the identical serialized batch with bounded full jitter;
other responses fail without retry. HTTPS is required except for an explicitly
enabled localhost/loopback test endpoint, and redirects or cross-origin
responses are rejected.

Composition: `runtime.observability.exporters`. Lifecycle:
`explicit-owned-or-borrowed`; every runtime registration states ownership,
requirement, and `remote-acknowledged` boundary.
