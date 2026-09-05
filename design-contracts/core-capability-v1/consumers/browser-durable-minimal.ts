import { createAgentRuntime } from '@ai-agent-sdk/core'
import { indexedDbObservationExporter } from '@ai-agent-sdk/observability-browser'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** Direct-browser BYOK remains opt-in and needs no OpenTelemetry package. */
export async function createBrowserDurableRuntime(apiKey: string, indexedDB: IDBFactory) {
  return await createAgentRuntime({
    providers: [openAiPlugin({ apiKey })],
    observability: {
      content: 'none',
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
