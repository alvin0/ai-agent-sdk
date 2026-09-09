# @alvin0/ai-agent-sdk-observability-browser

Runtime: **Browser** (IndexedDB and optional page lifecycle APIs).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-observability-browser
```

Browser-only local durability for the structured observation bus. The exporter
stages privacy-processed events in IndexedDB during synchronous capture and
confirms `local-durable` only after the transaction commits at flush/checkpoint.

```ts
import { createObservability } from '@alvin0/ai-agent-sdk-core/observability'
import { indexedDbObservationExporter } from '@alvin0/ai-agent-sdk-observability-browser'

const queue = indexedDbObservationExporter()

const observability = createObservability({
  mode: 'reliable',
  exporters: [{ exporter: queue, requirement: 'required', boundary: 'local-durable' }],
})
```

The database defaults to `ai-agent-sdk-observability`, schema version 1, with
`events`, `batches`, and `meta` stores. Stored events remain unacknowledged until
the host calls `acknowledgeBatch()` after its own remote sink confirms delivery.
`recoverEvents()` exposes crash/reopen recovery without importing a network
exporter. `installBrowserObservabilityLifecycle()` is opt-in and flushes on
hidden visibility and `pagehide`; it makes no unload-durability claim.

Composition: `runtime.observability.exporters`. Lifecycle:
`explicit-owned-or-borrowed`; normal browser runtime composition registers this
exporter as owned at the `local-durable` boundary.
