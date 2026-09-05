import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** A Node host does not need a Node SDK facade when its selected capabilities are Universal. */
export async function runNodeMinimal(apiKey: string): Promise<string> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey })],
  })

  try {
    const agent = runtime.agent({
      id: 'node-http-assistant',
      model: { provider: 'openai', id: 'gpt-5.4' },
      instructions: 'Help the user.',
    })
    return (await agent.generate('Hello')).text
  } finally {
    await runtime.close()
  }
}
