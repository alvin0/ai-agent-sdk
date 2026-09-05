import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import { createRuntimeHttpProvider } from '@ai-agent-sdk/provider-http'
import { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'

/** Compile-only proof that a third-party Universal provider can use public support contracts. */
export function exampleProvider(apiKey: string): ComposableModelProviderPlugin {
  const adapter = createRuntimeHttpProvider({
    displayName: 'Example Provider',
    protocol: openAiResponsesProtocol,
    baseUrl: new URL('https://example.test/v1'),
    auth: { kind: 'bearer', token: apiKey },
    models: [{ id: 'example-model' }],
  })

  return defineModelProviderPlugin({
    id: 'example',
    family: 'example-http',
    displayName: 'Example Provider',
    routes: ['example'],
    setup(registrar) {
      registrar.logger.debug('register example provider')
      registrar.registerAdapter(adapter)
    },
  })
}
