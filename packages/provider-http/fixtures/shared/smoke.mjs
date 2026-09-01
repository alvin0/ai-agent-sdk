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
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name.toLowerCase() === 'request-id' ? 'packed-request' : null
        },
      },
      body: new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          controller.close()
        },
      }),
    }
  }
  try {
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
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}
