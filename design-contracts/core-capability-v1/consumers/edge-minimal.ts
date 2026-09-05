import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

export async function runEdgeMinimal(apiKey: string, signal?: AbortSignal): Promise<string> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey, defaultModel: 'gpt-5.4' })],
    ...(signal === undefined ? {} : { signal }),
    resource: { serviceName: 'edge-chat' },
  })
  try {
    runtime.logger({ fields: { app: 'edge-chat' } }).info('runtime ready')
    const agent = runtime.agent({
      id: 'edge-assistant',
      instructions: 'Help the user.',
    })
    return (await agent.generate('Hello', {
      onEvent(event) {
        void event.runId
        void event.sequence
      },
    })).text
  } finally {
    await runtime.close()
  }
}
