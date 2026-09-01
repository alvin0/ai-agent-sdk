import { ModelRegistry, createCoreSpan } from '@ai-agent-sdk/core'
import { createPlugin, expectedCredential, frames, providerId } from './provider.mjs'

export async function runPackedProviderFixture() {
  const originalFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) { return name.toLowerCase() === 'request-id' ? 'packed-request' : null },
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
    registry.install(createPlugin())
    const handle = registry.stream({ provider: providerId, model: 'packed-model', messages: [] })
    let text = ''
    for await (const chunk of handle) if (chunk.type === 'text-delta') text += chunk.text
    const report = await handle.report
    const serialized = JSON.stringify(events)
    return {
      provider: providerId,
      text,
      totalTokens: report.reported.totalTokens,
      attempts: report.attempts.length,
      dispatchState: report.attempts[0]?.dispatchState,
      credentialEvents: events.filter(event => event.name === 'sdk.credential.operation').length,
      safeEvents: !serialized.includes(expectedCredential),
      buffer: typeof globalThis.Buffer,
      process: typeof globalThis.process,
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}
