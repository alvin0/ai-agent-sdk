import {
  createAgentRuntime,
  type RuntimeModelCatalogSnapshot,
} from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** Compile-only proof that a Web UI can build a model picker without escaping the runtime. */
export async function loadProviderCatalog(
  apiKey: string,
  signal: AbortSignal,
): Promise<RuntimeModelCatalogSnapshot> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey })],
    signal,
  })

  try {
    const providers = runtime.providers()
    if (!providers.some(provider =>
      provider.route === 'openai'
      && provider.pluginId === 'openai'
      && provider.family === 'openai')) {
      throw new Error('configured provider route is missing')
    }

    const catalog = await runtime.modelCatalog('openai', {
      signal,
      refresh: 'if-stale',
    })

    if (catalog.state === 'unavailable') {
      void catalog.error?.code
      // An explicit model target remains usable even when discovery is unavailable.
      runtime.agent({
        id: 'explicit-model-agent',
        model: { provider: 'openai', id: 'explicit-model' },
        instructions: 'Use the explicitly configured model.',
      })
    }

    return catalog
  } finally {
    const closeReport = await runtime.close()
    void closeReport.quiescenceEnd
    void closeReport.operations.find(operation => operation.kind === 'model-catalog')
  }
}
