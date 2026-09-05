import {
  ModelAdapter,
  defineModelProviderPlugin,
  type ModelInvocationContext,
  type StreamChunk,
} from '@ai-agent-sdk/core/provider'
import type { GenerateOptions } from '@ai-agent-sdk/core/provider'

class ExampleDirectAdapter extends ModelAdapter {
  async *stream(
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    void context?.resource?.runtimeId
    context?.logger?.debug('direct adapter stream', { model: options.model })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Compile-only proof for a non-HTTP third-party provider adapter. */
export const directAdapterProvider = defineModelProviderPlugin({
  id: 'direct-adapter',
  displayName: 'Direct adapter',
  routes: ['direct', 'direct-compatible'],
  setup(registrar) {
    const registration = registrar.registerAdapter(new ExampleDirectAdapter(), ['direct'])
    registration.replace(['direct', 'direct-compatible'])
    const removeMiddleware = registrar.use((_options, next, _context) => next())
    return () => {
      removeMiddleware()
      registration()
    }
  },
})
