# @ai-agent-sdk/observability

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/observability
```

Universal, bounded observability for `ai-agent-sdk`: structured lifecycle events,
privacy processing, priority queues, scoped logging, delivery health, flush and
shutdown, plus in-memory/test exporters. It uses Web standards only.

```ts
import { createObservability, MemoryObservationExporter } from '@ai-agent-sdk/observability'

const memory = new MemoryObservationExporter()
const observation = createObservability({
  exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
})
```

Reliable and audit modes require an exporter that explicitly declares a real
local-durable or remote-acknowledged boundary. An in-memory exporter can never be
configured as durable.
