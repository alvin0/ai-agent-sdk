import {
  defineCredentialSource,
  defineModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import {
  createRuntimeHttpProvider,
  defineWireProtocol,
} from '@ai-agent-sdk/provider-http'

const customProtocol = defineWireProtocol({
  id: 'custom-json-sse',
  defaultDialect: { version: '2026-09-02' },
  endpointPath: () => '/generate',
  protocolHeaders: dialect => ({ 'x-protocol-version': dialect.version }),
  serialize: request => ({
    model: request.model.id,
    messages: request.options.messages,
    tools: request.options.tools,
    native_tools: request.options.tools?.filter(tool => 'type' in tool && tool.type === 'native'),
    max_tokens: request.maxTokens,
  }),
  async *translate(events) {
    for await (const event of events) {
      if (event.data === '[DONE]') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: event.data }
    }
  },
})

defineWireProtocol({
  id: 'invalid-async-json-protocol',
  defaultDialect: {},
  endpointPath: () => '/generate',
  // @ts-expect-error Request serialization is synchronous so one prepared call has one frozen body.
  async serialize() { return { model: 'invalid' } },
  async *translate() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

const rotatingKey = defineCredentialSource({
  id: 'custom-provider-key',
  resolve({ signal }) {
    signal.throwIfAborted()
    return 'resolved-by-host'
  },
})

const headerAdapter = createRuntimeHttpProvider({
  displayName: 'Custom Header Provider',
  protocol: customProtocol,
  baseUrl: new URL('https://provider.example.test/v1'),
  auth: { kind: 'header', name: 'x-api-key', value: rotatingKey },
  models: [{ id: 'custom-model', inputModalities: ['text'] }],
  retryPolicy: { mode: 'normal', maxRetries: 2 },
  async discoverModels({ signal }) {
    signal.throwIfAborted()
    return [{ id: 'discovered-model' }]
  },
})

export const customHeaderProvider = defineModelProviderPlugin({
  id: 'custom-header-provider',
  displayName: 'Custom Header Provider',
  routes: ['custom-header'],
  setup(registrar) {
    const remove = registrar.registerAdapter(headerAdapter)
    return () => {
      remove()
    }
  },
})

export const dynamicAuthAdapter = createRuntimeHttpProvider({
  displayName: 'Custom Dynamic Auth Provider',
  protocol: customProtocol,
  baseUrl: 'https://dynamic.example.test',
  auth: {
    kind: 'dynamic',
    async resolve({ provider, signal }) {
      signal.throwIfAborted()
      return { authorization: `Signature host-supplied-for=${provider}` }
    },
  },
  fetch: globalThis.fetch,
})
