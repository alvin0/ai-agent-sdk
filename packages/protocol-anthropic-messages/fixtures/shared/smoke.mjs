import {
  anthropicMessagesProtocol,
  serializeAnthropicRequest,
  translateAnthropicStream,
} from '@ai-agent-sdk/protocol-anthropic-messages'

async function* frames() {
  const values = [
    { type: 'message_start', message: { usage: { input_tokens: 6, cache_read_input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}

export async function runPackedProtocolFixture() {
  const request = {
    options: { provider: 'packed', model: 'packed-model', messages: [] },
    maxTokens: 100,
  }
  const serialized = serializeAnthropicRequest(request, { budgets: {} })
  let usage
  for await (const chunk of translateAnthropicStream(frames(), 'Packed')) {
    if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    protocol: anthropicMessagesProtocol.id,
    model: serialized.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
