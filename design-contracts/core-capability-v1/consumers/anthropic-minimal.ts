import { createAgentRuntime } from '@ai-agent-sdk/core'
import { anthropicPlugin } from '@ai-agent-sdk/provider-anthropic'

/** Normal consumers select only core and the official provider package. */
export async function createMinimalAnthropicRuntime() {
  return await createAgentRuntime({
    providers: [anthropicPlugin({ apiKey: 'host-injected-anthropic-key' })],
  })
}
