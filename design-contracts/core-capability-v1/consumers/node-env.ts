import { envCredential } from '@ai-agent-sdk/auth-node'
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

/** Selecting environment credential convenience intentionally elevates this recipe to Node. */
export async function runNodeWithEnvironmentCredential(): Promise<string> {
  const runtime = await createAgentRuntime({
    providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
  })

  try {
    const agent = runtime.agent({
      id: 'node-env-assistant',
      model: { provider: 'openai', id: 'gpt-5.4' },
      instructions: 'Help the user.',
    })
    return (await agent.generate('Hello')).text
  } finally {
    await runtime.close()
  }
}
