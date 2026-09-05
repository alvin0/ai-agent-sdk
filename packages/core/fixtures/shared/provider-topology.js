/** Packed Web-runtime evidence for two installations of one provider family. */
export async function providerTopologyEvidence({ ModelAdapter, createAgentRuntime }) {
  class CatalogAdapter extends ModelAdapter {
    constructor(model) { super(); this.model = model }
    listModels(provider) {
      return Promise.resolve([{ provider, id: this.model, name: this.model }])
    }
    stream() {
      return (async function* () {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }

  const plugin = (id, route, model) => ({
    kind: 'model-provider-plugin', apiVersion: 1, id, family: 'openai',
    displayName: `OpenAI ${id}`, routes: [route],
    setup(registrar) { registrar.registerAdapter([route], new CatalogAdapter(model)) },
  })
  const runtime = await createAgentRuntime({ providers: [
    plugin('account-a', 'route-a', 'model-a'),
    plugin('account-b', 'route-b', 'model-b'),
  ] })
  try {
    const providers = runtime.providers().map(({ route, pluginId, family }) => ({ route, pluginId, family }))
    const catalogs = await Promise.all(['route-a', 'route-b'].map(async route => {
      const catalog = await runtime.modelCatalog(route)
      return {
        route: catalog.provider.route,
        pluginId: catalog.provider.pluginId,
        family: catalog.provider.family,
        model: catalog.models[0]?.id,
      }
    }))
    return { providers, catalogs }
  } finally {
    await runtime.close()
  }
}
