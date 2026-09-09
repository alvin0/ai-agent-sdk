import {
  geminiInteractionsProtocol,
  serializeGeminiInteractionsRequest,
  translateGeminiInteractionsStream,
} from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'

async function* frames() {
  yield {
    event: 'interaction.completed',
    data: JSON.stringify({
      event_type: 'interaction.completed',
      interaction: {
        status: 'completed',
        usage: {
          total_input_tokens: 10,
          total_cached_tokens: 4,
          total_output_tokens: 2,
          total_tokens: 12,
        },
      },
    }),
  }
}

export async function runPackedProtocolFixture() {
  const request = {
    options: { provider: 'packed', model: 'packed-model', messages: [] },
    maxTokens: 100,
  }
  const serialized = serializeGeminiInteractionsRequest(
    request,
    geminiInteractionsProtocol.defaultDialect,
  )
  let usage
  for await (const chunk of translateGeminiInteractionsStream(frames(), 'Packed', request)) {
    if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    protocol: geminiInteractionsProtocol.id,
    model: serialized.model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
