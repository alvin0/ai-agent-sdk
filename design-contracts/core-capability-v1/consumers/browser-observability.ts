import { createAgentRuntime } from '@ai-agent-sdk/core'
import { indexedDbObservationExporter } from '@ai-agent-sdk/observability-browser'
import {
  createOpenTelemetryBridge,
  type OpenTelemetryBridgeOptions,
} from '@ai-agent-sdk/observability-otel'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** Browser composition keeps OTel providers caller-owned and IndexedDB runtime-owned. */
export async function createBrowserObservedRuntime(
  apiKey: string,
  tracer: OpenTelemetryBridgeOptions['tracer'],
  meter: OpenTelemetryBridgeOptions['meter'],
  indexedDB: IDBFactory,
) {
  const bridge = createOpenTelemetryBridge({ tracer, meter, content: 'none' })
  return await createAgentRuntime({
    providers: [openAiPlugin({ apiKey })],
    observability: {
      content: 'none',
      openSpan: bridge.openSpan,
      processors: [bridge.processor],
      exporters: [{
        exporter: indexedDbObservationExporter({
          id: 'browser-journal',
          databaseName: 'agent-observations',
          indexedDB,
          maxEvents: 50_000,
          maxBytes: 64 * 1024 * 1024,
          openTimeoutMs: 10_000,
        }),
        ownership: 'owned',
        requirement: 'best-effort',
        boundary: 'local-durable',
      }],
    },
  })
}
