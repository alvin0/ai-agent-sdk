import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import { createRuntimeHttpProvider } from '@ai-agent-sdk/provider-http'
import { anthropicMessagesProtocol } from '@ai-agent-sdk/protocol-anthropic-messages'

/** Compile-only proof for a third-party Anthropic Messages-compatible provider. */
export function exampleAnthropicProvider(apiKey: string): ComposableModelProviderPlugin {
  const adapter = createRuntimeHttpProvider({
    displayName: 'Example Anthropic Provider',
    protocol: anthropicMessagesProtocol,
    baseUrl: new URL('https://example.test'),
    auth: { kind: 'header', name: 'x-api-key', value: apiKey },
    models: [{ id: 'example-anthropic-model' }],
  })

  return defineModelProviderPlugin({
    id: 'example-anthropic',
    family: 'example-anthropic-messages',
    displayName: 'Example Anthropic Provider',
    routes: ['example-anthropic'],
    setup(registrar) {
      registrar.registerAdapter(adapter)
    },
  })
}
