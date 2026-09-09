# @alvin0/ai-agent-sdk-observability-node

Runtime: **Node 22.12+**.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-observability-node
```

Node-only durable observation journal and explicit lifecycle/diagnostic helpers.
The journal root is always caller-supplied. Records use checksum-framed JSONL,
private directory/file modes, unique segments, atomic acknowledgment cursors,
bounded retention, and strict corruption recovery.

Exact provider-wire diagnostics are a separate high-risk capability and refuse
construction unless both `content: 'full'` and `allowWireBodies: true` are set.
Nothing installs process lifecycle handlers automatically.

For normal runtime composition, use the inert `jsonlObservationExporter()`
factory. Filesystem resources are acquired only when `createAgentRuntime()`
calls its `ready()` lifecycle boundary:

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  jsonlObservationExporter,
  recoverRuntimeObservationJournal,
} from '@alvin0/ai-agent-sdk-observability-node'

const runtime = await createAgentRuntime({
  providers: [provider],
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: jsonlObservationExporter({
        rootDir: './observations',
        mode: 'reliable',
      }),
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

await runtime.close()
const recovered = await recoverRuntimeObservationJournal('./observations')
```

The runtime adapter persists privacy-filtered events and atomic terminal run
records in `runtime-delivery/`, and acknowledges their IDs separately. The
caller still closes the runtime explicitly; an owned exporter is closed by the
runtime after all active runs settle. `recoverRuntimeObservationJournal()`
verifies checksums and returns both event and terminal-run records from this
recommended format; `recoverJournal()` remains the advanced legacy-journal
recovery API.

Composition: `runtime.observability.exporters`. Lifecycle:
`explicit-owned-or-borrowed`; normal JSONL composition selects owned local
durability, while advanced hosts may retain a borrowed exporter explicitly.

Use `@alvin0/ai-agent-sdk-observability-node/journal` when only durable journal and
lifecycle APIs are needed, or `@alvin0/ai-agent-sdk-observability-node/diagnostic` for
the separately gated exact-wire capability. That diagnostic route exports
`createDailyJsonlRequestLogger()` and `combineProviderRequestLoggers()` for
provider request-logger slots. The root entry re-exports both.
