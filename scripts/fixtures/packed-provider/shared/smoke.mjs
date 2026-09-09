import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { createPlugin, expectedCredential, frames, providerId } from './provider.mjs'

export async function runPackedProviderFixture() {
  const originalFetch = globalThis.fetch
  const events = []
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
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
      body: new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          controller.close()
        },
      }),
    }
  }
  try {
    const runtime = await createAgentRuntime({ providers: [createPlugin()] })
    try {
      const response = await runtime.agent({
        id: 'packed-provider-agent',
        model: { provider: providerId, id: 'packed-model' },
        instructions: 'Return the fixture response.',
        compaction: false,
      }).generate('Run the packed provider fixture.')
      events.push(...runtime.diagnostics().events)
      const modelCall = response.report.modelCalls[0]
      const serialized = JSON.stringify(events)
      return {
        provider: providerId,
        text: response.text,
        totalTokens: response.usage.reported.totalTokens,
        attempts: modelCall?.attempts.length,
        dispatchState: modelCall?.attempts[0]?.dispatchState,
        credentialEvents: events.filter(event => event.name === 'sdk.credential.operation').length,
        safeEvents: !serialized.includes(expectedCredential),
        buffer: typeof globalThis.Buffer,
        process: typeof globalThis.process,
      }
    } finally {
      await runtime.close()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
}
