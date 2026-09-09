import { ModelRegistry, createCoreSpan } from '@ai-agent-sdk/core'
import { createHttpProvider } from '@ai-agent-sdk/provider-http'

const protocol = {
  id: 'packed-protocol',
  defaultDialect: Object.freeze({}),
  endpointPath: () => '/stream',
  serialize: request => ({ model: request.options.model }),
  async *translate(events) {
    for await (const event of events) {
      const value = JSON.parse(event.data)
      if (value.type === 'text') yield { type: 'text-delta', index: 0, text: value.text }
      if (value.type === 'usage') yield { type: 'usage', usage: value.usage }
      if (value.type === 'done') yield { type: 'finish', reason: { kind: 'stop' } }
    }
  },
}

export async function runPackedProviderFixture() {
  const originalFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    const frames = [
      { type: 'text', text: 'packed provider completed' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
      { type: 'done' },
    ]
    const body = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          controller.close()
        },
      })
    return {
      type: 'basic',
      redirected: false,
      url: '',
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const normalized = name.toLowerCase()
          if (normalized === 'content-type') return 'text/event-stream'
          if (normalized === 'request-id') return 'packed-request'
          return null
        },
      },
      body,
    }
  }
  try {
    let staticCredentialCalls = 0
    let staticDiscoveryCalls = 0
    const staticProvider = createHttpProvider({
      displayName: 'Packed static metadata',
      protocol,
      baseUrl: 'https://packed-static.invalid/v1',
      auth: { kind: 'bearer', token: () => { staticCredentialCalls++; return 'unused' } },
      models: [{
        id: 'declared', contextWindow: 64_000, maxTokens: 2_048,
        inputModalities: ['text', 'image'], nativeTools: ['web-search'],
      }],
      discoverModels: async () => { staticDiscoveryCalls++; return [{ id: 'ignored' }] },
    })
    const staticCatalog = await staticProvider.modelCatalog('packed-static')
    const staticModel = await staticProvider.resolveModel('packed-static', 'declared')
    const observation = {
      mode: 'operational',
      openSpan: createCoreSpan,
      capture(event) {
        events.push(event)
        return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
      },
    }
    const registry = new ModelRegistry({ observation })
    registry.registerAdapter(['packed'], createHttpProvider({
      displayName: 'Packed',
      protocol,
      baseUrl: 'https://packed.invalid/v1',
      auth: { kind: 'bearer', token: 'injected-test-token' },
    }))
    const handle = registry.stream({ provider: 'packed', model: 'm', messages: [] })
    let text = ''
    for await (const chunk of handle) if (chunk.type === 'text-delta') text += chunk.text
    const report = await handle.report
    return {
      text,
      totalTokens: report.reported.totalTokens,
      attempts: report.attempts.length,
      dispatchState: report.attempts[0]?.dispatchState,
      requestId: report.attempts[0]?.providerRequestId,
      eventCount: events.length,
      staticCatalogState: staticCatalog.state,
      staticModelContext: staticModel.context?.contextWindow,
      staticModelTool: staticModel.nativeTools?.[0],
      staticCredentialCalls,
      staticDiscoveryCalls,
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}
